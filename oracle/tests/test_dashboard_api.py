import os
import pytest
from fastapi.testclient import TestClient

from tereflow_oracle import dashboard as dash
from tereflow_oracle.comtrade import Row
from tereflow_oracle.ingest import Ingestor
from tests.test_oracle import Fake, conn, q, R1  # noqa: F401

os.environ["ORACLE_API_TOKEN"] = "test-token"
from tereflow_oracle.api import app, _cache  # noqa: E402

H = {"Authorization": "Bearer test-token"}
client = TestClient(app)


def rows():
    return [Row("WLD", "090111", "Coffee", 10e6, None, None, None),
            Row("USA", "090111", "Coffee", 5e6, 1e6, None, None),
            Row("DEU", "090111", "Coffee", 3e6, None, None, None),
            Row("FRA", "090111", "Coffee", 2e6, None, None, None),
            Row("WLD", "999999", "Commodities not specified", 1e6, None, None, None),
            Row("USA", "999999", "Commodities not specified", 1e6, None, None, None)]


@pytest.fixture
def loaded(conn):
    _cache.clear()
    cur = conn.cursor()
    cur.execute("DELETE FROM tf_dashboard_cache WHERE reporter_iso3=:1", [R1])
    conn.commit()
    for y in (2023, 2024):
        Ingestor(conn, Fake(rows=rows())).run([R1], [y])
    yield conn
    cur.execute("DELETE FROM tf_dashboard_cache WHERE reporter_iso3=:1", [R1])
    conn.commit()
    _cache.clear()


def test_dashboard_from_facts(loaded):
    d = dash.load_dashboard(loaded, R1)
    o = d["overview"]
    assert o["year"] == 2024 and o["export_usd"] == 11e6 and o["import_usd"] == 11e6   # includes the unclassified line
    assert o["partner_count"] == 3 and o["product_count"] == 2
    top = d["top_exports"][0]
    assert top["code"] == "090111" and top["share_pct"] == pytest.approx(10 / 11 * 100) and top["yoy_pct"] == 0
    assert [p["code"] for p in d["partners_export"]] == ["USA", "DEU", "FRA"]
    assert d["partners_export"][0]["share_pct"] == pytest.approx(6 / 11 * 100)
    assert [t["year"] for t in d["trend"]] == [2023, 2024]

def test_lines_exclude_unclassified_but_total_keeps_it(loaded):
    l = dash.load_lines(loaded, R1, "M")
    assert l["year"] == 2024 and [x["hs_code"] for x in l["lines"]] == ["090111"]
    assert l["country_total_usd"] == 11e6

def test_cache_roundtrip_and_api(loaded):
    assert dash.refresh_dashboard(loaded, R1) == 3
    assert dash.read_cached(loaded, R1, "dashboard")["overview"]["year"] == 2024
    r = client.get(f"/api/dashboard/{R1}", headers=H)
    assert r.status_code == 200 and r.json()["overview"]["export_usd"] == 11e6
    assert client.get(f"/api/lines/{R1}?flow=X", headers=H).json()["lines"][0]["hs_code"] == "090111"

def test_api_auth_and_errors(loaded):
    assert client.get(f"/api/dashboard/{R1}").status_code == 401
    assert client.get("/api/dashboard/PLW", headers=H).status_code == 404
    assert client.get(f"/api/lines/{R1}?flow=Z", headers=H).status_code == 400
