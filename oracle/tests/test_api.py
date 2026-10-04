import os
import pytest
from fastapi.testclient import TestClient

from tereflow_oracle.ingest import Ingestor
from tereflow_oracle.comtrade import Row
from tests.test_oracle import Fake, rows6, conn, q, R1  # noqa: F401  (fixtures)

os.environ["ORACLE_API_TOKEN"] = "test-token"
from tereflow_oracle.api import app  # noqa: E402

H = {"Authorization": "Bearer test-token"}
client = TestClient(app)


@pytest.fixture
def seeded(conn):
    cur = conn.cursor()
    cur.execute("DELETE FROM tf_country WHERE iso3=:1", [R1])
    cur.execute("INSERT INTO tf_country (iso3, m49, name, slug, is_active) VALUES (:1, 296, 'Kiribati', 'kiribati', 1)", [R1])
    conn.commit()
    rows = rows6() + [Row("USA", "09011110", "dummy", 1.0, None, None, None)][:0]
    Ingestor(conn, Fake(rows=rows)).run([R1], [2024])
    yield conn
    cur.execute("DELETE FROM tf_country WHERE iso3=:1", [R1])
    conn.commit()


def post(partners, primary="kiribati", headers=H):
    return client.post("/api/trade/sandbox", json={"primary": primary, "partners": partners}, headers=headers)


def test_requires_token(seeded):
    assert post(["USA"], headers={}).status_code == 401
    assert post(["USA"], headers={"Authorization": "Bearer nope"}).status_code == 401

def test_validation(seeded):
    assert post([], ).status_code == 400
    assert post(["USA"], primary="").status_code == 400
    assert post(["ZZZ"]).status_code == 400
    assert post(["KIR"]).status_code == 400
    assert post(["USA"], primary="nowhere").status_code == 400

def test_partner_rows_totals_and_unreported(seeded):
    r = post(["USA", "FRA", "JPN"]).json()
    usa, fra, jpn = r["partners"]
    assert r["primary"]["iso3"] == "KIR" and 2024 in r["years"]
    y = {t["year"]: t for t in usa["totals"]}
    assert y[2024]["export_usd"] == 60 and y[2024]["import_usd"] == 60
    assert y[2023]["export_usd"] is None                      # no rows is null, not 0
    assert usa["classification_level"] == "HS6" and usa["reporter_basis"] == "primary"
    assert fra["products"] == [] and fra["unreported_rows"] == 2   # NULL value is not shown as 0
    assert fra["totals"][-2]["export_usd"] is None
    assert jpn["reporter_basis"] == "none" and jpn["classification_level"] is None

def test_product_total_is_all_partners_not_selected(seeded):
    r = post(["USA"]).json()
    tot = {(t["year"], t["flow"], t["hs_code"]): t["value_usd"] for t in r["primary_product_totals"]}
    assert tot[(2024, "export", "090111")] == 100            # USA 60 + DEU 40 + GBR 0, WLD row excluded
