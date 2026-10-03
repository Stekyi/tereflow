"""Tests. Resolver tests are pure; the rest run against the real Oracle database
with a fake Comtrade client, using throw-away reporters that are cleaned up."""
import pytest

from tereflow_oracle import analytics, classify
from tereflow_oracle.classify import Availability as A
from tereflow_oracle.comtrade import FetchResult, Row, RateLimited, ComtradeError
from tereflow_oracle.config import load_env
from tereflow_oracle.ingest import Ingestor

load_env()
R1, R2 = "KIR", "PLW"  # tiny reporters, used only by tests


# ---------- classification resolver -------------------------------------
def test_ghana_style_hs6_only():
    sel = classify.resolve(None, A(6, 402572))
    assert (sel.source, sel.level) == ("FINAL", "HS6")

def test_tariffline_hs8_preferred():
    sel = classify.resolve(A(8, 1000), A(6, 500))
    assert (sel.source, sel.level, sel.length) == ("TARIFFLINE", "HS8", 8)

def test_tariffline_hs10():
    assert classify.resolve(A(10, 5), A(6, 5)).level == "HS10"

def test_tariffline_zero_records_not_used():
    assert classify.resolve(A(8, 0), A(6, 10)).level == "HS6"

def test_nothing_reported():
    assert classify.resolve(None, None) is None

def test_no_inferred_extension():
    assert classify.resolve(A(None, None), A(6, 7)).length == 6


# ---------- fake Comtrade ------------------------------------------------
class Fake:
    def __init__(self, tl=None, fn=A(6, 3, None, "chk1", "rel1"), rows=None, error=None, truncated=False, rate=False):
        self.tl, self.fn, self.rows, self.error, self.truncated, self.rate = tl, fn, rows, error, truncated, rate
        self.calls = 0
    def availability(self, m49, year, tariffline):
        return self.tl if tariffline else self.fn
    def _res(self):
        self.calls += 1
        if self.rate: raise RateLimited(30)
        if self.error: raise ComtradeError(self.error)
        return FetchResult(list(self.rows), 1, self.truncated)
    def fetch_hs6(self, *a): return self._res()
    def fetch_tariffline(self, *a): return self._res()

def rows6():
    return [Row("WLD", "090111", "Coffee", 100.0, None, None, None),
            Row("USA", "090111", "Coffee", 60.0, 5.0, None, None),
            Row("DEU", "090111", "Coffee", 40.0, None, None, None),
            Row("FRA", "090111", "Coffee", None, None, None, None),   # value not reported
            Row("GBR", "090111", "Coffee", 0.0, 0.0, None, None)]      # genuine zero


@pytest.fixture
def conn():
    from tereflow_oracle import db
    c = db.connect()
    def wipe():
        cur = c.cursor()
        for t in ("tf_trade_facts", "tf_ingest_state", "tf_comtrade_availability", "tf_product_metrics"):
            col = "reporter_iso3"
            cur.execute(f"DELETE FROM {t} WHERE {col} IN (:1,:2)", [R1, R2])
        cur.execute("DELETE FROM tf_ingest_error WHERE reporter_iso3 IN (:1,:2)", [R1, R2])
        c.commit()
    wipe(); yield c; wipe(); c.close()

def expire_avail(c):
    cur = c.cursor()
    cur.execute("UPDATE tf_comtrade_availability SET checked_at = SYSTIMESTAMP - INTERVAL '30' DAY WHERE reporter_iso3 IN (:1,:2)", [R1, R2])
    c.commit()


def q(c, sql, *p):
    cur = c.cursor(); cur.execute(sql, list(p)); return cur.fetchall()


def test_ingest_stores_rows_keeps_null_and_zero(conn):
    s = Ingestor(conn, Fake(rows=rows6())).run([R1], [2023])
    assert s.status == "SUCCESS" and s.success == 2
    got = dict(q(conn, "SELECT partner_iso3, value_usd FROM tf_trade_facts WHERE reporter_iso3=:1 AND flow='X'", R1))
    assert got["FRA"] is None and got["GBR"] == 0 and got["USA"] == 60
    assert q(conn, "SELECT DISTINCT classification_level FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [("HS6",)]

def test_rerun_is_idempotent_and_skips(conn):
    f = Fake(rows=rows6())
    Ingestor(conn, f).run([R1], [2023]); calls = f.calls
    s = Ingestor(conn, f).run([R1], [2023])
    assert s.skipped == 2 and f.calls == calls
    assert q(conn, "SELECT COUNT(*) FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [(10,)]

def test_force_does_not_duplicate(conn):
    f = Fake(rows=rows6())
    Ingestor(conn, f).run([R1], [2023])
    Ingestor(conn, f, force=True).run([R1], [2023])
    assert q(conn, "SELECT COUNT(*) FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [(10,)]

def test_changed_release_replaces_year(conn):
    Ingestor(conn, Fake(rows=rows6())).run([R1], [2023])
    expire_avail(conn)
    f2 = Fake(fn=A(6, 3, None, "chk2", "rel2"), rows=[Row("USA", "090111", "Coffee", 999.0, None, None, None)])
    Ingestor(conn, f2).run([R1], [2023])
    assert q(conn, "SELECT COUNT(*), MAX(value_usd) FROM tf_trade_facts WHERE reporter_iso3=:1 AND flow='X'", R1) == [(1, 999)]

def test_failed_country_does_not_stop_others(conn):
    class Mixed(Fake):
        def fetch_hs6(self, m49, year, flow, m):
            self.error = "boom" if m49 == 296 else None
            return super()._res()
    s = Ingestor(conn, Mixed(rows=rows6())).run([R1, R2], [2023])
    assert s.failed == 2 and s.success == 2 and s.status == "PARTIAL"
    assert q(conn, "SELECT COUNT(*) FROM tf_ingest_error WHERE reporter_iso3=:1", R1)[0][0] == 2

def test_truncated_never_reported_success(conn):
    s = Ingestor(conn, Fake(rows=rows6(), truncated=True)).run([R1], [2023])
    assert s.success == 0 and s.failed == 2
    assert q(conn, "SELECT COUNT(*) FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [(0,)]

def test_failure_keeps_previous_data(conn):
    Ingestor(conn, Fake(rows=rows6())).run([R1], [2023])
    expire_avail(conn)
    s = Ingestor(conn, Fake(fn=A(6, 3, None, "new", "new"), rows=[], error="down")).run([R1], [2023])
    assert s.failed == 2
    assert q(conn, "SELECT COUNT(*) FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [(10,)]
    assert q(conn, "SELECT status, retry_count FROM tf_ingest_state WHERE reporter_iso3=:1 AND flow='X'", R1) == [("FAILED", 1)]

def test_rate_limit_stops_run_and_is_resumable(conn):
    s = Ingestor(conn, Fake(rows=rows6(), rate=True)).run([R1, R2], [2023])
    assert s.stopped_on_rate_limit and s.status == "RATE_LIMIT"
    assert q(conn, "SELECT COUNT(*) FROM tf_ingest_state WHERE reporter_iso3=:1", R2) == [(0,)]
    s2 = Ingestor(conn, Fake(rows=rows6())).run([R1, R2], [2023])
    assert s2.success == 4

def test_tariffline_empty_falls_back_to_hs6(conn):
    class T(Fake):
        def fetch_tariffline(self, *a): return FetchResult([], 1)
    s = Ingestor(conn, T(tl=A(8, 50, None, "t", "t"), rows=rows6())).run([R1], [2023])
    assert s.success == 2
    assert q(conn, "SELECT DISTINCT classification_level FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [("HS6",)]

def test_tariffline_level_recorded(conn):
    rows = [Row("USA", "09011110", "Coffee x", 5.0, None, None, None)]
    Ingestor(conn, Fake(tl=A(8, 5, None, "t", "t"), rows=rows)).run([R1], [2023])
    assert q(conn, "SELECT DISTINCT classification_level FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [("HS8",)]

def test_no_data_is_recorded_not_zero(conn):
    s = Ingestor(conn, Fake(fn=None)).run([R1], [2023])
    assert s.no_data == 1
    assert q(conn, "SELECT COUNT(*) FROM tf_trade_facts WHERE reporter_iso3=:1", R1) == [(0,)]
    assert q(conn, "SELECT DISTINCT status FROM tf_ingest_state WHERE reporter_iso3=:1", R1) == [("NO_DATA",)]

def test_dry_run_writes_nothing(conn):
    f = Fake(rows=rows6())
    s = Ingestor(conn, f, dry_run=True).run([R1], [2023])
    assert len(s.planned) == 2 and f.calls == 0
    assert q(conn, "SELECT COUNT(*) FROM tf_ingest_state WHERE reporter_iso3=:1", R1) == [(0,)]


# ---------- sandbox / market share / metrics --------------------------------
def test_partner_vs_all_partner_and_share(conn):
    Ingestor(conn, Fake(rows=rows6())).run([R1], [2023])
    tot = q(conn, "SELECT all_partner_value_usd, partner_rows, partner_rows_with_value FROM v_sandbox_product_totals WHERE reporter_iso3=:1 AND flow='X'", R1)
    assert tot == [(100, 4, 3)]                          # WLD row excluded, NULL not counted as value
    sh = dict(q(conn, "SELECT partner_iso3, partner_share_pct FROM v_market_share WHERE reporter_iso3=:1 AND flow='X'", R1))
    assert sh["USA"] == 60 and sh["DEU"] == 40 and sh["FRA"] is None and sh["GBR"] == 0
    rec = q(conn, "SELECT diff_pct FROM v_world_reconciliation WHERE reporter_iso3=:1 AND flow='X'", R1)
    assert rec == [(0,)]

def test_metrics_deterministic(conn):
    f = Fake(rows=[Row("USA", "090111", "Coffee", 60.0, None, None, None), Row("DEU", "090111", "Coffee", 40.0, None, None, None)])
    Ingestor(conn, f).run([R1], [2022, 2023])
    n1 = analytics.refresh_metrics(conn, R1)
    a = q(conn, "SELECT * FROM tf_product_metrics WHERE reporter_iso3=:1 ORDER BY flow, cmd_code", R1)
    n2 = analytics.refresh_metrics(conn, R1)
    b = q(conn, "SELECT * FROM tf_product_metrics WHERE reporter_iso3=:1 ORDER BY flow, cmd_code", R1)
    assert n1 == n2 == 2 and [x[:15] for x in a] == [x[:15] for x in b]
    row = q(conn, "SELECT latest_year, years_available, latest_value_usd, yoy_pct, cagr_3y_pct, top_partner_iso3, top_partner_share_pct, supplier_hhi FROM tf_product_metrics WHERE reporter_iso3=:1 AND flow='X'", R1)[0]
    assert row == (2023, 2, 100, 0, None, "USA", 60, 0.52)   # 3y CAGR needs 4 years: null, not zero


