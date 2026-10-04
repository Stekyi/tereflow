import pytest

from tereflow_oracle import dashboard as dash, opportunity as op
from tereflow_oracle.comtrade import Row
from tereflow_oracle.ingest import Ingestor
from tests.test_oracle import Fake, conn, q, R1  # noqa: F401


def rows():
    # One chapter-27 line (traditional by admin rule, excluded by Ghana config), one ordinary line,
    # one small line (above the 100k feed floor, below the 1M market floor), and a total line.
    return [Row("WLD", "270900", "Crude oil", 9e6, None, None, None), Row("USA", "270900", "Crude oil", 6e6, None, None, None),
            Row("DEU", "270900", "Crude oil", 3e6, None, None, None),
            Row("WLD", "090111", "Coffee", 10e6, None, None, None), Row("USA", "090111", "Coffee", 6e6, 1e6, None, None),
            Row("FRA", "090111", "Coffee", 4e6, None, None, None),
            Row("WLD", "080450", "Mangoes", 400e3, None, None, None), Row("GBR", "080450", "Mangoes", 400e3, None, None, None),
            Row("WLD", "000000", "Total", 20e6, None, None, None)]


@pytest.fixture
def scored(conn, monkeypatch):
    monkeypatch.setitem(op.CONFIG, R1, op.CONFIG["GHA"])
    for y in (2022, 2023, 2024):
        Ingestor(conn, Fake(rows=rows())).run([R1], [y])
    op.refresh_opportunities(conn, R1)
    yield conn
    cur = conn.cursor()
    cur.execute("DELETE FROM tf_opportunity WHERE reporter_iso3=:1", [R1])
    cur.execute("DELETE FROM tf_dashboard_cache WHERE reporter_iso3=:1", [R1])
    conn.commit()


def test_below_floor_is_separate_from_chapter_exclusion(scored):
    flags = {(r[0], r[1]): (r[2], r[3]) for r in q(scored, "SELECT flow, cmd_code, is_excluded, below_floor FROM tf_opportunity WHERE reporter_iso3=:1", R1)}
    assert flags[("M", "270900")] == (1, 0)     # excluded by Ghana config, but a real market
    assert flags[("M", "090111")] == (0, 0)
    assert flags[("M", "080450")] == (1, 1)     # 400k is below the 1M market floor
    assert ("M", "000000") not in flags         # a total line is never scored as a product

def test_product_feed_has_small_lines_but_not_totals_and_leaves_chapters_to_the_admin(scored):
    feed = dash.load_products(scored, R1)
    codes = {(p["flow"], p["code"]) for p in feed["products"]}
    assert ("M", "270900") in codes             # the admin classification decides, not this feed
    assert ("M", "080450") in codes             # small but above the 100k feed floor
    assert not any(c == "000000" for _, c in codes)
    top = next(p for p in feed["products"] if p["code"] == "090111" and p["flow"] == "M")
    assert top["partners"][0] == {"iso3": "USA", "name": "United States", "value_usd": 6e6}
    assert top["year"] == feed["latest_year"] == 2024

def test_cached_blue_oceans_are_unmasked_by_config(scored):
    masked = {b["product_code"] for b in op.blue_oceans(scored, R1)}
    unmasked = {b["product_code"] for b in op.blue_oceans(scored, R1, apply_config_exclusions=False)}
    assert "270900" not in masked and masked <= unmasked

def test_refresh_stores_products_and_blue_oceans(scored):
    assert dash.refresh_dashboard(scored, R1) == 5
    assert dash.read_cached(scored, R1, "products")["count"] >= 3
    assert "blue_oceans" in dash.read_cached(scored, R1, "blue_oceans")
