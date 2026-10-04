import os
import pytest
from tereflow_oracle.config import load_env
load_env()
URL, CID, SEC = (os.environ.get(k) for k in ("ORACLE_ORDS_URL", "ORACLE_CLIENT_ID", "ORACLE_CLIENT_SECRET"))
pytestmark = pytest.mark.skipif(not (URL and CID and SEC), reason="ORDS settings not configured")
import requests
from tereflow_oracle import db, dashboard as dash


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{URL}/oauth/token", data={"grant_type": "client_credentials"}, auth=(CID, SEC), timeout=30)
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def conn():
    c = db.connect()
    yield c
    c.close()


def same(a, b):
    assert (a is None and b is None) or a == pytest.approx(b, rel=1e-9, abs=1e-6)


@pytest.mark.parametrize("flow,code", [("X", "180100"), ("M", "27"), ("X", "1801"), ("X", "710813")])
def test_product_route_matches_python(auth, conn, flow, code):
    od = requests.get(f"{URL}/tf/product/GHA/{flow}/{code}", headers=auth, timeout=60).json()
    py = dash.load_product_detail(conn, "GHA", flow, code)
    assert od["latest_year"] == py["latest_year"] and od["level"] == py["level"]
    assert [r["year"] for r in od["series"]] == [r["year"] for r in py["series"]]
    for a, b in zip(od["series"], py["series"]):
        same(a["value_usd"], b["value_usd"]); same(a["qty_kg"], b["qty_kg"])
    assert [(p["iso3"]) for p in od["partners"]] == [p["iso3"] for p in py["partners"]]
    for a, b in zip(od["partners"], py["partners"]):
        same(a["value_usd"], b["value_usd"])


def test_a_heading_covers_its_lines_and_a_chapter_covers_its_headings(auth):
    one = requests.get(f"{URL}/tf/product/GHA/X/180100", headers=auth, timeout=60).json()
    head = requests.get(f"{URL}/tf/product/GHA/X/1801", headers=auth, timeout=60).json()
    chap = requests.get(f"{URL}/tf/product/GHA/X/18", headers=auth, timeout=60).json()
    y = lambda d: d["series"][-1]["value_usd"]
    assert y(one) == pytest.approx(y(head)) and y(chap) > y(head)       # 1801 is a single line; chapter 18 adds paste, butter, powder


def test_product_route_errors(auth):
    assert requests.get(f"{URL}/tf/product/GHA/Z/180100", headers=auth, timeout=60).status_code == 400
    assert requests.get(f"{URL}/tf/product/GHA/X/1", headers=auth, timeout=60).status_code == 400
    assert requests.get(f"{URL}/tf/product/GHA/X/123456", headers=auth, timeout=60).status_code == 404
    assert requests.get(f"{URL}/tf/product/GHA/X/180100").status_code == 401


def test_stats_route_matches_python(auth, conn):
    od = requests.get(f"{URL}/tf/stats", headers=auth, timeout=60).json()
    py = dash.load_stats(conn)
    assert od["countries_with_data"] == py["countries_with_data"] >= 2 and od["facts"] == py["facts"] and od["last_run"] == py["last_run"]
