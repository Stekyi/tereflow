"""
Tests for the HTML parser and data-file discovery modules.

Two kinds of test live here and they are kept apart on purpose.

The offline tests are the backbone. They pin the discovery scorer against
hand-built pages: an extension link, an export query, a fragment file, an
Apache autoindex, an S3 bucket listing, a penalised metadata link, malformed
markup. They do not touch the network and they must always pass.

The live tests check the same discovery code against the four real registry
URLs the source list actually contains, because a scorer that passes on
fixtures but mis-ranks CEPII is worthless. They fetch with a browser user
agent and, when the network is down or a site blocks the fetch, they skip
rather than fail. A red bar should mean the code is wrong, not that a train
went into a tunnel.

The html_static tests need the normalize modules, which another worker owns and
which do not exist on disk yet. Rather than create them, the tests register
small fakes in sys.modules before importing html_static, so the import
succeeds against known behaviour without inventing files that are not ours to
write.

This file runs under pytest if it is installed, and stands alone if it is not:
the block at the bottom discovers the test functions, runs them, and reports
pass, skip, and fail counts. Skips use unittest.SkipTest, which pytest also
reports as a skip.
"""

from __future__ import annotations

import os
import sys
import types
import unittest

_EXTRACT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EXTRACT_ROOT not in sys.path:
    sys.path.insert(0, _EXTRACT_ROOT)

from tereflow_extract.parsers.discovery import find_data_links, DataLink

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _fetch(url: str) -> tuple[bytes, str]:
    """Fetch a URL with a browser UA, or skip the test if it cannot be reached."""
    try:
        import httpx
    except ImportError:
        raise unittest.SkipTest("httpx is not installed")
    try:
        resp = httpx.get(
            url, headers={"User-Agent": _UA}, follow_redirects=True, timeout=30.0
        )
    except Exception as exc:
        raise unittest.SkipTest(f"network unavailable for {url}: {exc}")
    if resp.status_code != 200:
        raise unittest.SkipTest(f"{url} returned {resp.status_code}, cannot assert")
    return resp.content, str(resp.url)


# ---------------------------------------------------------------------------
# discovery: offline unit tests (the stable backbone)
# ---------------------------------------------------------------------------


def test_extension_link_beats_about_link():
    html = b"""
    <html><body>
      <h2>Merchandise exports by country</h2>
      <a href="/files/exports-2025.csv">Download CSV</a>
      <a href="/about">About this dataset</a>
      <a href="/contact">Contact us</a>
    </body></html>
    """
    links = find_data_links(html, "https://example.org/data/")
    assert links, "expected at least one data link"
    top = links[0]
    assert top.url == "https://example.org/files/exports-2025.csv"
    assert top.guessed_type == "csv"
    urls = [d.url for d in links]
    assert "https://example.org/about" not in urls
    assert "https://example.org/contact" not in urls


def test_export_query_is_detected():
    html = b"""
    <html><body>
      <a href="/api/table?pid=123&format=csv">Export table</a>
    </body></html>
    """
    links = find_data_links(html, "https://example.org/")
    assert len(links) == 1
    assert links[0].guessed_type == "csv"
    assert "export" in links[0].reason.lower()


def test_fragment_file_is_detected():
    # StatCan names the real file in the URL fragment, not the path.
    html = b"""
    <html><body>
      <a href="/t1/tbl1/en/tv.action?pid=1210012101#?pid=12100121&file=1210012101-eng.csv">
        CSV Download as displayed
      </a>
    </body></html>
    """
    links = find_data_links(html, "https://www150.statcan.gc.ca/")
    assert len(links) == 1
    assert links[0].guessed_type == "csv"
    assert "fragment" in links[0].reason.lower()


def test_metadata_link_is_penalised_or_dropped():
    html = b"""
    <html><body>
      <a href="/data/trade-2025.csv">Download trade data CSV</a>
      <a href="/data/metadata.csv">Download metadata CSV</a>
    </body></html>
    """
    links = find_data_links(html, "https://example.org/")
    assert links, "expected the trade csv to survive"
    assert links[0].url.endswith("trade-2025.csv")
    meta = [d for d in links if "metadata" in d.url]
    if meta:
        assert meta[0].score < links[0].score
        assert "metadata" in meta[0].reason.lower()


def test_recency_prefers_newest_year():
    html = b"""
    <html><body>
      <a href="/exports_2024.csv">Exports CSV 2024</a>
      <a href="/exports_2026.csv">Exports CSV 2026</a>
    </body></html>
    """
    links = find_data_links(html, "https://example.org/")
    assert len(links) == 2
    assert links[0].url.endswith("exports_2026.csv")


def test_trade_relevance_breaks_ties():
    html = b"""
    <html><body>
      <a href="/download/a.csv">Download exports of merchandise</a>
      <a href="/download/b.csv">Download staff phone list</a>
    </body></html>
    """
    links = find_data_links(html, "https://example.org/")
    assert links[0].url.endswith("a.csv")
    assert "trade" in links[0].reason.lower()


def test_want_biases_toward_type():
    html = b"""
    <html><body>
      <a href="/download/data.csv">Download</a>
      <a href="/download/data.xlsx">Download</a>
    </body></html>
    """
    excel_first = find_data_links(html, "https://example.org/", want="excel")
    assert excel_first[0].guessed_type == "excel"
    csv_first = find_data_links(html, "https://example.org/", want="csv")
    assert csv_first[0].guessed_type == "csv"


def test_weak_word_alone_is_not_a_data_link():
    # "Data" pointing at a portal page is navigation, not a file.
    html = b"""
    <html><body>
      <a href="/data-portal/">Data</a>
      <a href="/explore/">Explore the data</a>
    </body></html>
    """
    links = find_data_links(html, "https://example.org/")
    assert links == []


def test_apache_directory_listing():
    html = b"""
    <html><head><title>Index of /production</title></head><body>
    <h1>Index of /production</h1>
    <pre>
      <a href="?C=N;O=D">Name</a>  <a href="?C=M;O=A">Last modified</a>
      <a href="../">Parent Directory</a>
      <a href="Production_Crops_E_All_Data.zip">Production_Crops_E_All_Data.zip</a> 2026-01-01
      <a href="Trade_DetailedTradeMatrix_E_All_Data.csv">Trade_DetailedTradeMatrix_E_All_Data.csv</a>
      <a href="readme.txt">readme.txt</a>
      <a href="subfolder/">subfolder/</a>
    </pre>
    </body></html>
    """
    links = find_data_links(html, "https://bulks-faostat.fao.org/production/")
    urls = [d.url for d in links]
    assert "https://bulks-faostat.fao.org/production/Production_Crops_E_All_Data.zip" in urls
    assert (
        "https://bulks-faostat.fao.org/production/Trade_DetailedTradeMatrix_E_All_Data.csv"
        in urls
    )
    # Parent, sort links, and subdirectories are not files.
    assert not any(u.endswith("/production/") for u in urls)
    assert not any("?C=" in u for u in urls)
    assert not any(u.endswith("subfolder/") for u in urls)
    assert all("dir" in d.reason.lower() for d in links)


def test_s3_bucket_listing():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Name>bulks-faostat.fao.org</Name>
      <Prefix>production/</Prefix>
      <Contents><Key>production/Production_Crops_E_All_Data.zip</Key><Size>1234</Size></Contents>
      <Contents><Key>production/Trade_2025_E.csv</Key><Size>567</Size></Contents>
      <Contents><Key>production/</Key><Size>0</Size></Contents>
    </ListBucketResult>
    """
    links = find_data_links(xml, "https://bulks-faostat.fao.org/?prefix=production/")
    urls = [d.url for d in links]
    assert "https://bulks-faostat.fao.org/production/Production_Crops_E_All_Data.zip" in urls
    assert "https://bulks-faostat.fao.org/production/Trade_2025_E.csv" in urls
    # The prefix key itself is a folder marker, not a file.
    assert not any(u.endswith("production/") for u in urls)


def test_malformed_html_returns_empty_not_exception():
    for bad in (b"", b"<not html <<<", b"\x00\x01\x02\x03", b"<a href="):
        out = find_data_links(bad, "https://example.org/")
        assert isinstance(out, list)


def test_datalink_shape():
    html = b'<a href="/x.csv">Download CSV</a>'
    links = find_data_links(html, "https://example.org/")
    assert links
    d = links[0]
    assert isinstance(d, DataLink)
    assert 0.0 <= d.score <= 1.0
    assert d.reason and isinstance(d.reason, str)


# ---------------------------------------------------------------------------
# discovery: live tests against the real registry URLs (skip when offline)
# ---------------------------------------------------------------------------


def test_live_cepii_surfaces_baci_zips():
    html, base = _fetch("https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37")
    links = find_data_links(html, base)
    assert links, "CEPII returned no data links, expected the BACI zips"
    baci = [d for d in links if "baci" in d.url.lower() and d.guessed_type == "zip"]
    assert baci, "expected at least one BACI zip among the candidates"
    # The landing pages for other databases must not be mistaken for data.
    assert not any("bdd_modele_item.asp" in d.url for d in links)
    top = links[0]
    assert top.guessed_type in ("zip", "csv", "excel")


def test_live_statcan_surfaces_csv_zip_not_metadata():
    html, base = _fetch("https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1210012101")
    links = find_data_links(html, base)
    assert links, "StatCan returned no data links, expected the CSV download"
    csv_zip = [d for d in links if "/tbl/csv/" in d.url and d.url.endswith(".zip")]
    assert csv_zip, "expected the whole-table CSV zip"
    assert not any("downloadCubeMetaData" in d.url for d in links)


def test_live_harvard_is_empty_without_rendering():
    # Harvard builds its download links in JavaScript. Static discovery is
    # correct to find nothing, which is the case that justifies html_dynamic.
    html, base = _fetch("https://atlas.hks.harvard.edu/data-downloads/")
    links = find_data_links(html, base)
    assert links == [], f"expected no static data links, got {[d.url for d in links]}"


def test_live_fao_returns_a_list():
    # The bulk host serves a zero-byte S3 placeholder for this path with bucket
    # listing disabled, so the honest live result is no links. The listing
    # parsers are proven on fixtures in the offline tests above.
    html, base = _fetch("https://bulks-faostat.fao.org/production/")
    links = find_data_links(html, base)
    assert isinstance(links, list)


# ---------------------------------------------------------------------------
# html_static: needs normalize modules, which are faked in sys.modules
# ---------------------------------------------------------------------------


def _install_fake_normalize():
    """
    Was a stand-in for normalize modules that did not exist yet.

    They exist now, so this does nothing. Leaving the fakes in place was worse
    than useless: registering them in sys.modules shadowed the real modules, so
    every test below exercised a simplified number reader rather than the one
    that ships, and a header-scale bug worth a factor of a thousand passed
    unnoticed while the suite stayed green.

    Kept as a no-op rather than deleted so the call sites still read and the
    reason stays on the record.
    """
    return


def _unused_fake_normalize():
    def _mod(name: str) -> types.ModuleType:
        m = types.ModuleType(name)
        sys.modules[name] = m
        return m

    numbers = _mod("tereflow_extract.normalize.numbers")

    def parse_number(raw):
        if raw is None:
            return None
        if isinstance(raw, (int, float)):
            return float(raw) if raw == raw else None
        s = str(raw).strip().replace(",", "").replace(" ", "")
        for sym in ("$", "€", "£", "¥", "%"):
            s = s.replace(sym, "")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None

    numbers.parse_number = parse_number

    currency = _mod("tereflow_extract.normalize.currency")

    def detect_currency(text):
        t = (text or "").lower()
        if "usd" in t or "us dollar" in t or "$" in t:
            return "USD", 0.9
        if "eur" in t or "euro" in t or "€" in t:
            return "EUR", 0.9
        return None, 0.0

    currency.detect_currency = detect_currency

    countries = _mod("tereflow_extract.normalize.countries")

    def resolve_country(name):
        table = {
            "canada": ("CAN", "Canada"),
            "germany": ("DEU", "Germany"),
            "united states": ("USA", "United States"),
            "france": ("FRA", "France"),
        }
        key = (name or "").strip().lower()
        if key in table:
            iso3, canonical = table[key]
            return iso3, canonical, 0.95
        return None, None, 0.0

    countries.resolve_country = resolve_country

    commodities = _mod("tereflow_extract.normalize.commodities")

    def parse_hs(text):
        import re as _re

        m = _re.search(r"\b(\d{2,6})\b", str(text or ""))
        if m:
            return m.group(1), 0.8
        return None, 0.0

    commodities.parse_hs = parse_hs

    fields = _mod("tereflow_extract.normalize.fields")

    def map_header(header):
        h = (header or "").strip().lower()
        if not h:
            return None
        pairs = [
            ("reporter", "reporter"),
            ("partner", "partner"),
            ("product", "product"),
            ("commodity", "product"),
            ("hs code", "hs_code"),
            ("hs_code", "hs_code"),
            ("flow", "flow"),
            ("currency", "currency"),
            ("value", "value"),
            ("year", "year"),
            ("quantity", "qty"),
            ("unit", "qty_unit"),
            ("sector", "sector"),
        ]
        for needle, field in pairs:
            if needle in h:
                return field
        return None

    def detect_flow(text):
        t = (text or "").lower()
        if "export" in t:
            return "export", 0.9
        if "import" in t:
            return "import", 0.9
        return None, 0.0

    def parse_year(text):
        import re as _re

        m = _re.search(r"(?<!\d)(19|20)\d{2}(?!\d)", str(text or ""))
        if m:
            return int(m.group(0)), 0.9
        return None, 0.0

    fields.map_header = map_header
    fields.detect_flow = detect_flow
    fields.parse_year = parse_year


def _load_static():
    _install_fake_normalize()
    for name in list(sys.modules):
        if name.endswith("parsers.html_static"):
            del sys.modules[name]
    from tereflow_extract.parsers import html_static

    return html_static


def test_static_reads_a_real_data_table():
    hs = _load_static()
    html = b"""
    <html><body>
      <h3>Merchandise exports, values in USD</h3>
      <table>
        <tr><th>Reporter</th><th>Partner</th><th>Value</th><th>Year</th></tr>
        <tr><td>Canada</td><td>Germany</td><td>1,234.5</td><td>2025</td></tr>
        <tr><td>Canada</td><td>France</td><td>987.0</td><td>2025</td></tr>
      </table>
    </body></html>
    """
    rows = hs.parse_html_tables(html, "https://example.org/report")
    assert len(rows) == 2
    first = rows[0]
    assert first.reporter_name == "Canada"
    assert first.reporter_iso3 == "CAN"
    assert first.partner_iso3 == "DEU"
    assert first.value == 1234.5
    assert first.year == 2025
    # The caption states USD, so currency is established and value_usd follows.
    assert first.currency == "USD"
    assert first.value_usd == 1234.5
    assert first.usd_basis == "reported"
    assert first.confidence == 0.0
    assert first.provenance is not None
    assert first.provenance.table_index == 0
    assert first.provenance.locator == "table[0]"
    assert first.provenance.row_index == 0
    # pandas.read_html applies thousands="," by default, so the grouping comma
    # is consumed at parse time and the printed value pandas kept is "1234.5".
    assert first.provenance.raw_value == "1234.5"


def test_static_never_assumes_usd():
    hs = _load_static()
    html = b"""
    <html><body>
      <h3>Merchandise exports</h3>
      <table>
        <tr><th>Reporter</th><th>Partner</th><th>Value</th><th>Year</th></tr>
        <tr><td>Canada</td><td>Germany</td><td>1000</td><td>2025</td></tr>
      </table>
    </body></html>
    """
    rows = hs.parse_html_tables(html, "https://example.org/report")
    assert len(rows) == 1
    assert rows[0].value == 1000.0
    # Currency was not stated anywhere, so it stays unknown and value_usd None.
    assert rows[0].currency is None
    assert rows[0].value_usd is None
    assert rows[0].usd_basis is None


def test_static_skips_layout_tables():
    hs = _load_static()
    html = b"""
    <html><body>
      <table><tr><td>Home</td><td>Search</td><td>Login</td></tr></table>
      <table>
        <tr><th>Menu</th></tr>
        <tr><td>Section one</td></tr>
        <tr><td>Section two</td></tr>
      </table>
    </body></html>
    """
    rows = hs.parse_html_tables(html, "https://example.org/")
    assert rows == []


def test_static_main_text():
    hs = _load_static()
    article = b"""
    <html><body>
      <nav>Home About Contact</nav>
      <article>
        <h1>Trade in 2025</h1>
        <p>Merchandise exports rose across most partners during the year, with
        the strongest growth recorded in manufactured goods and machinery.</p>
        <p>Officials noted that the figures remain provisional and subject to
        revision as late returns are processed.</p>
      </article>
      <footer>Copyright</footer>
    </body></html>
    """
    text = hs.extract_main_text(article, "https://example.org/news")
    assert isinstance(text, str)
    assert hs.extract_main_text(b"", "https://example.org/") == ""


# ---------------------------------------------------------------------------
# html_dynamic: availability contract holds even without Playwright
# ---------------------------------------------------------------------------


def test_dynamic_reports_unavailable_clearly():
    from tereflow_extract.parsers import html_dynamic

    available, reason = html_dynamic.rendering_available()
    assert isinstance(available, bool)
    if not available:
        assert "playwright" in reason.lower()
        assert "install" in reason.lower()


def test_dynamic_render_never_returns_empty_html_when_unavailable():
    from tereflow_extract.parsers import html_dynamic

    available, _ = html_dynamic.rendering_available()
    if available:
        raise unittest.SkipTest("Playwright is installed; the unavailable path is not exercised")
    html, note = html_dynamic.render("https://example.org/", wait_ms=0, timeout_ms=5000)
    # None, never empty bytes, so a caller cannot read it as a tableless page.
    assert html is None
    assert isinstance(note, str) and note


# ---------------------------------------------------------------------------
# standalone runner, so the file works without pytest installed
# ---------------------------------------------------------------------------


def _run_standalone() -> int:
    tests = sorted(
        (name, obj)
        for name, obj in globals().items()
        if name.startswith("test_") and callable(obj)
    )
    passed = skipped = failed = 0
    for name, fn in tests:
        try:
            fn()
        except unittest.SkipTest as exc:
            skipped += 1
            print(f"SKIP {name}: {exc}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # a crash in a test is a failure, not a stop
            failed += 1
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
        else:
            passed += 1
            print(f"PASS {name}")
    print(f"\n{passed} passed, {skipped} skipped, {failed} failed, {len(tests)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_standalone())
