"""Live ORDS checks. Skipped unless the ORDS settings are in the environment (.env).
Compares the ORDS sandbox with the Python API for the same request, so the two cannot drift."""
import base64
import json
import os

import pytest
import requests
from fastapi.testclient import TestClient

from tereflow_oracle.config import load_env

load_env()
URL, CID, SEC = (os.environ.get(k) for k in ("ORACLE_ORDS_URL", "ORACLE_CLIENT_ID", "ORACLE_CLIENT_SECRET"))
pytestmark = pytest.mark.skipif(not (URL and CID and SEC), reason="ORDS settings not configured")


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{URL}/oauth/token", data={"grant_type": "client_credentials"}, auth=(CID, SEC), timeout=30)
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_requires_token():
    assert requests.get(f"{URL}/tf/dashboard/GHA", timeout=30).status_code == 401
    assert requests.get(f"{URL}/tf/dashboard/GHA", headers={"Authorization": "Bearer nope"}, timeout=30).status_code == 401


def test_cached_routes(auth):
    d = requests.get(f"{URL}/tf/dashboard/GHA", headers=auth, timeout=60).json()
    assert d["overview"]["year"] >= 2024 and d["top_exports"] and d["trend"]
    assert requests.get(f"{URL}/tf/dashboard/PLW", headers=auth, timeout=60).status_code == 404
    lines = requests.get(f"{URL}/tf/lines/GHA?flow=M", headers=auth, timeout=60).json()
    assert lines["lines"] and requests.get(f"{URL}/tf/lines/GHA?flow=Z", headers=auth, timeout=60).status_code == 400
    assert "blue_oceans" in requests.get(f"{URL}/tf/blue-oceans/GHA", headers=auth, timeout=60).json()


@pytest.mark.parametrize("q,msg", [("primary=&partners=DEU", "primary country is required"),
                                    ("primary=ghana&partners=", "select at least one"),
                                    ("primary=ghana&partners=ZZZ", "Unknown partner ISO3: ZZZ"),
                                    ("primary=ghana&partners=GHA", "cannot also be a partner"),
                                    ("primary=nowhere&partners=DEU", "not an active country")])
def test_sandbox_validation(auth, q, msg):
    r = requests.get(f"{URL}/tf/sandbox?{q}", headers=auth, timeout=60)
    assert r.status_code == 400 and msg in r.json()["error"]


def test_sandbox_matches_python_api(auth):
    os.environ["ORACLE_API_TOKEN"] = "t"
    from tereflow_oracle.api import app
    py = TestClient(app).post("/api/trade/sandbox", json={"primary": "ghana", "partners": ["NGA", "JPN"]},
                              headers={"Authorization": "Bearer t"}).json()
    od = requests.get(f"{URL}/tf/sandbox?primary=ghana&partners=NGA,JPN", headers=auth, timeout=120).json()
    assert py["primary"] == od["primary"] and py["years"] == od["years"] and py["note"] == od["note"]
    for a, b in zip(py["partners"], od["partners"]):
        for k in ("iso3", "classification_level", "reporter_basis", "years", "unreported_rows"):
            assert a[k] == b[k], k
        key = lambda p: (p["hs_code"], p["flow"], p["year"], p["value_usd"], p["qty_kg"], p["classification_level"])
        assert sorted(map(key, a["products"])) == sorted(map(key, b["products"]))
        for x, y in zip(a["totals"], b["totals"]):
            for k in ("export_usd", "import_usd"):
                assert (x[k] is None and y[k] is None) or x[k] == pytest.approx(y[k], abs=1e-3)
    ta = sorted((t["year"], t["flow"], t["hs_code"], round(t["value_usd"], 2)) for t in py["primary_product_totals"])
    tb = sorted((t["year"], t["flow"], t["hs_code"], round(t["value_usd"], 2)) for t in od["primary_product_totals"])
    assert ta == tb


def test_sandbox_exclude_hides_codes_and_empty_exclude_hides_nothing(auth):
    full = requests.get(f"{URL}/tf/sandbox?primary=ghana&partners=CHE", headers=auth, timeout=120).json()
    none = requests.get(f"{URL}/tf/sandbox?primary=ghana&partners=CHE&exclude=", headers=auth, timeout=120).json()
    cut = requests.get(f"{URL}/tf/sandbox?primary=ghana&partners=CHE&exclude=71,27", headers=auth, timeout=120).json()
    n = lambda r: len(r["partners"][0]["products"])
    assert n(full) == n(none) > 0
    assert 0 < n(cut) < n(full)
    assert not any(p["hs_code"].startswith(("71", "27")) for p in cut["partners"][0]["products"])
    assert not any(t["hs_code"].startswith(("71", "27")) for t in cut["primary_product_totals"])
    # a digit-only filter: anything else in the list is ignored rather than treated as a wildcard
    wild = requests.get(f"{URL}/tf/sandbox?primary=ghana&partners=CHE&exclude=%25", headers=auth, timeout=120).json()
    assert n(wild) == n(full)


def test_products_route(auth):
    d = requests.get(f"{URL}/tf/products/GHA", headers=auth, timeout=120).json()
    assert d["count"] > 1000 and d["products"][0]["code"] and d["latest_year"] >= 2024