import pytest
from fastapi.testclient import TestClient

from tereflow_oracle import opportunity as op
from tereflow_oracle.comtrade import Row
from tereflow_oracle.ingest import Ingestor
from tests.test_oracle import Fake, conn, q, expire_avail, R1  # noqa: F401

import os
os.environ["ORACLE_API_TOKEN"] = "test-token"
from tereflow_oracle.api import app  # noqa: E402

H = {"Authorization": "Bearer test-token"}
client = TestClient(app)


def rows():
    return [Row("WLD", "090111", "Coffee", 10e6, None, None, None),
            Row("USA", "090111", "Coffee", 5e6, 1e6, None, None),
            Row("DEU", "090111", "Coffee", 3e6, None, None, None),
            Row("FRA", "090111", "Coffee", 2e6, None, None, None),
            Row("GBR", "270900", "Fuel", 9e6, None, None, None),
            Row("CHN", "270900", "Fuel", 1e6, None, None, None)]


@pytest.fixture
def scored(conn, monkeypatch):
    monkeypatch.setitem(op.CONFIG, R1, op.CONFIG["GHA"])
    cur = conn.cursor()
    cur.execute("DELETE FROM tf_opportunity WHERE reporter_iso3=:1", [R1])
    conn.commit()
    for y in (2022, 2023, 2024):
        Ingestor(conn, Fake(rows=rows())).run([R1], [y])
    n = op.refresh_opportunities(conn, R1)
    yield conn, n
    cur.execute("DELETE FROM tf_opportunity WHERE reporter_iso3=:1", [R1])
    conn.commit()


def test_refresh_scores_and_is_deterministic(scored):
    conn, n = scored
    assert n == 4                                    # 2 products x 2 flows
    a = q(conn, "SELECT flow, cmd_code, opportunity_score, signal_type, is_excluded FROM tf_opportunity WHERE reporter_iso3=:1 ORDER BY 1,2", R1)
    assert op.refresh_opportunities(conn, R1) == 4
    b = q(conn, "SELECT flow, cmd_code, opportunity_score, signal_type, is_excluded FROM tf_opportunity WHERE reporter_iso3=:1 ORDER BY 1,2", R1)
    assert a == b
    d = {(r[0], r[1]): r for r in a}
    assert d[("M", "270900")][4] == 1                # chapter 27 excluded by config, kept and flagged
    assert d[("M", "090111")][4] == 0 and d[("M", "090111")][3] == "import_substitution"
    assert d[("X", "090111")][3] == "export_growth"

def test_blue_ocean_uses_structured_metrics(scored):
    conn, _ = scored
    bo = op.blue_oceans(conn, R1)
    assert [(b["product_code"], b["kind"]) for b in bo] == [("090111", "concentrated_supply")]
    b = bo[0]
    assert b["top_partner"] == "United States" and b["partner_iso3"] == "USA"
    assert b["top_partner_share_pct"] == pytest.approx(50) and b["supplier_hhi"] == pytest.approx(0.38)
    assert b["value_usd"] == 10e6 and b["evidence"] and b["limitations"][0].startswith("Room in the data")

def test_excluded_never_blue_ocean(scored):
    conn, _ = scored
    assert all(b["product_code"] != "270900" for b in op.blue_oceans(conn, R1))

def test_api_endpoints(scored):
    r = client.get(f"/api/blue-oceans/{R1}", headers=H).json()
    assert r["blue_oceans"][0]["kind"] == "concentrated_supply"
    assert client.get(f"/api/blue-oceans/{R1}").status_code == 401
    o = client.get(f"/api/opportunities/{R1}?flow=M", headers=H).json()["opportunities"]
    assert [x["product_code"] for x in o] == ["090111"]           # excluded hidden by default
    o2 = client.get(f"/api/opportunities/{R1}?flow=M&include_excluded=true", headers=H).json()["opportunities"]
    assert {x["product_code"] for x in o2} == {"090111", "270900"}
    assert client.get(f"/api/opportunities/{R1}?flow=Z", headers=H).status_code == 400

def test_missing_config_fails_loudly(conn):
    with pytest.raises(RuntimeError):
        op.build(conn, "PLW")
