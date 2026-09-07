"""
Exercise the three parsers against fixtures and one real statistical file.

The normalize.* helpers are owned by another worker and are not on disk yet, so
this harness injects functional stub modules under their exact import paths
before importing the parsers. The stubs match the documented signatures closely
enough to drive real behaviour: European and US number formats, currency
symbols and codes, country resolution via pycountry, HS extraction, header
mapping that deliberately refuses bare years, flow detection, and year parsing.

Run directly with the venv python:
    .venv\\Scripts\\python.exe tests\\test_parsers.py
It also works under pytest if that is preferred.
"""

from __future__ import annotations

import io
import json
import math
import re
import sys
import types
from pathlib import Path

# The package lives at extract/tereflow_extract. Put extract/ on the path so
# "import tereflow_extract..." resolves as a namespace package from disk.
_EXTRACT_DIR = Path(__file__).resolve().parent.parent
if str(_EXTRACT_DIR) not in sys.path:
    sys.path.insert(0, str(_EXTRACT_DIR))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Stub normalize modules, injected before the parsers are imported.
# ---------------------------------------------------------------------------

def _parse_number(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return None if math.isnan(f) else f
    s = str(v).strip()
    if not s:
        return None
    s = re.sub(r"[^0-9,.\-]", "", s)
    if s in ("", "-", ".", ",", "--"):
        return None
    if "," in s and "." in s:
        # The separator that appears last is the decimal one.
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        if len(parts) == 2 and len(parts[1]) in (1, 2):
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


# The real numbers module exposes this alongside parse_number so a column
# headed "Value (US$ thousand)" is not read as bare units. The stub mirrors its
# contract (value, note) so the parser's flag plumbing is exercised here.
_MAGNITUDE = {
    "thousand": 1e3,
    "thousands": 1e3,
    "million": 1e6,
    "millions": 1e6,
    "billion": 1e9,
    "billions": 1e9,
}


def _parse_number_with_scale(raw, header_hint=None):
    value = _parse_number(raw)
    if value is None:
        return (None, None)
    if header_hint:
        low = str(header_hint).lower()
        for word, mult in _MAGNITUDE.items():
            if re.search(r"\b" + word + r"\b", low):
                return (value * mult, f"scale-from-header:{word}")
    return (value, None)


_SYMBOLS = {"$": "USD", "\u20ac": "EUR", "\u00a3": "GBP", "\u00a5": "JPY"}
_CODES = {"usd", "eur", "gbp", "jpy", "cny", "chf", "cad", "aud"}


def _detect_currency(text):
    if not text:
        return (None, 0.0)
    s = str(text)
    for sym, iso in _SYMBOLS.items():
        if sym in s:
            return (iso, 1.0)
    low = s.lower()
    for code in _CODES:
        if re.search(r"\b" + code + r"\b", low):
            return (code.upper(), 1.0)
    if "euro" in low:
        return ("EUR", 0.9)
    if "dollar" in low:
        return ("USD", 0.6)
    return (None, 0.0)


def _resolve_country(name):
    if not name:
        return (None, None, 0.0)
    s = str(name).strip()
    if not s:
        return (None, None, 0.0)
    try:
        import pycountry

        c = pycountry.countries.lookup(s)
        return (c.alpha_3, c.name, 1.0)
    except Exception:
        return (None, None, 0.0)


def _parse_hs(text):
    if not text:
        return (None, 0.0)
    m = re.search(r"\b(\d{4,8})\b", str(text))
    if m:
        return (m.group(1), 1.0)
    return (None, 0.0)


_CANON = {
    "reporter": "reporter", "reporting country": "reporter",
    "reporting economy": "reporter", "declarant": "reporter",
    "reporter country": "reporter", "country": "reporter",
    "partner": "partner", "partner country": "partner",
    "partner economy": "partner", "counterpart": "partner",
    "product": "product", "commodity": "product",
    "hs": "hs_code", "hs code": "hs_code", "hs_code": "hs_code",
    "flow": "flow", "trade flow": "flow", "direction": "flow",
    "value": "value", "trade value": "value", "amount": "value",
    "currency": "currency", "curr": "currency",
    "year": "year", "period": "year", "time": "year", "time_period": "year",
    "qty": "qty", "quantity": "qty",
    "unit": "qty_unit", "qty unit": "qty_unit", "unit_measure": "qty_unit",
    "sector": "sector",
    "area": "reporter", "item": "product", "element": "flow",
}


def _map_header(h):
    if h is None:
        return None
    s = str(h).strip().lower()
    s = re.sub(r"\(.*?\)", "", s).strip()
    s = re.sub(r"[^a-z0-9_ ]", "", s).strip()
    s = re.sub(r"\s+", " ", s)
    if not s:
        return None
    return _CANON.get(s)


def _detect_flow(text):
    if not text:
        return (None, 0.0)
    low = str(text).strip().lower()
    if "export" in low or low in ("x", "exp"):
        return ("export", 1.0)
    if "import" in low or low in ("m", "imp"):
        return ("import", 1.0)
    return (None, 0.0)


def _parse_year(text):
    if text is None:
        return (None, 0.0)
    m = re.search(r"\b(19|20)\d{2}\b", str(text))
    if m:
        return (int(m.group(0)), 1.0)
    return (None, 0.0)


def _install_stub_normalize():
    """
    Was a stand-in for normalize modules that did not exist yet.

    They exist now, so this deliberately does nothing. Leaving the stubs in
    place was actively harmful: they shadowed the real modules in sys.modules,
    so the parsers under test ran against a simplified number reader instead of
    the one that ships. That hid a header-scale bug worth a factor of a
    thousand, and the tests stayed green throughout.

    Kept as a no-op rather than deleted so the call sites below still read, and
    so the reason is on the record.
    """
    return


def _unused_stub_normalize():
    pkg = types.ModuleType("tereflow_extract.normalize")
    pkg.__path__ = []  # marks it as a package for submodule imports
    sys.modules["tereflow_extract.normalize"] = pkg

    numbers = types.ModuleType("tereflow_extract.normalize.numbers")
    numbers.parse_number = _parse_number
    numbers.parse_number_with_scale = _parse_number_with_scale
    currency = types.ModuleType("tereflow_extract.normalize.currency")
    currency.detect_currency = _detect_currency
    countries = types.ModuleType("tereflow_extract.normalize.countries")
    countries.resolve_country = _resolve_country
    commodities = types.ModuleType("tereflow_extract.normalize.commodities")
    commodities.parse_hs = _parse_hs
    fields = types.ModuleType("tereflow_extract.normalize.fields")
    fields.map_header = _map_header
    fields.detect_flow = _detect_flow
    fields.parse_year = _parse_year

    for mod in (numbers, currency, countries, commodities, fields):
        sys.modules[mod.__name__] = mod
    # Attach as attributes so "from ..normalize.numbers import x" resolves.
    pkg.numbers = numbers
    pkg.currency = currency
    pkg.countries = countries
    pkg.commodities = commodities
    pkg.fields = fields


_install_stub_normalize()

from tereflow_extract.contracts import SourceType  # noqa: E402
from tereflow_extract.parsers.tabular import parse_tabular  # noqa: E402
from tereflow_extract.parsers.api_json import parse_json  # noqa: E402
from tereflow_extract.parsers.sdmx import parse_sdmx  # noqa: E402


# ---------------------------------------------------------------------------
# Fixture builders.
# ---------------------------------------------------------------------------

def _write_csv_fixture() -> Path:
    # Five preamble rows before the real header, semicolon delimited, European
    # decimal commas, years pivoted into columns, plus a World and a Total row.
    lines = [
        "Statistical Office of Exampleland",
        "Annual Trade Report 2021",
        "Generated 2022-03-01",
        "Contact: stats@example.gov",
        "(figures in thousands of EUR)",
        "Partner;Flow;2019;2020;2021",
        "France;Exports;100,5;110,2;120,0",
        "Germany;Exports;200,0;210,0;220,0",
        "World;Exports;1000,0;1100,0;1200,0",
        "Total;Exports;9999,0;9999,0;9999,0",
    ]
    path = FIXTURES / "sample_wide_semicolon.csv"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _write_excel_fixture() -> Path:
    from openpyxl import Workbook

    wb = Workbook()
    ws1 = wb.active
    ws1.title = "Exports2021"
    # Preamble, then a wide header with years as columns.
    ws1.append(["National Statistics Agency"])
    ws1.append(["Merchandise exports by partner"])
    ws1.append([])
    ws1.append(["Reporter", "Partner", "2018", "2019", "2020"])
    ws1.append(["United States", "France", 10, 11, 12])
    ws1.append(["United States", "Germany", 20, 21, 22])

    ws2 = wb.create_sheet("Summary")
    # Long format with an explicit USD value column.
    ws2.append(["Reporter", "Partner", "Flow", "Value (USD)", "Year"])
    ws2.append(["United States", "Canada", "Import", 500, 2020])
    ws2.append(["United States", "Mexico", "Import", 750, 2020])

    path = FIXTURES / "sample_two_sheets.xlsx"
    wb.save(path)
    return path


def _write_json_fixture() -> Path:
    doc = {
        "header": {"id": "req-1", "prepared": "2022-01-01"},
        "meta": {"note": "example payload"},
        "data": [
            {
                "reporter": "United States",
                "partner": "France",
                "flow": "Export",
                "value": "1234.5",
                "currency": "USD",
                "year": "2020",
            },
            {
                "reporter": "United States",
                "partner": "Germany",
                "flow": "Export",
                "value": "2000",
                "currency": "USD",
                "year": "2020",
            },
            {"note": "footnote only, not a record"},
        ],
        "sources": [{"id": "x", "title": "y"}, {"id": "z", "title": "w"}],
    }
    path = FIXTURES / "sample_nested.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _write_json_columnar_fixture() -> Path:
    doc = {
        "columns": ["reporter", "partner", "value", "year"],
        "rows": [
            ["United States", "France", 100, 2019],
            ["United States", "Germany", 200, 2019],
        ],
    }
    path = FIXTURES / "sample_columnar.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _write_json_error_fixture() -> Path:
    doc = {"error": {"code": 500, "message": "Internal Server Error"}}
    path = FIXTURES / "sample_error.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _write_sdmx_ml_fixture() -> Path:
    # SDMX-ML 2.1 generic data that references an external DSD. sdmx1 rejects
    # this (no DSD), so it drives the lxml fallback path.
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<GenericData xmlns="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message"
             xmlns:g="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/generic">
  <g:DataSet>
    <g:Series>
      <g:SeriesKey>
        <g:Value id="REPORTER" value="US"/>
        <g:Value id="PARTNER" value="FR"/>
        <g:Value id="FLOW" value="EXP"/>
      </g:SeriesKey>
      <g:Attributes>
        <g:Value id="CURRENCY" value="USD"/>
      </g:Attributes>
      <g:Obs>
        <g:ObsDimension value="2020"/>
        <g:ObsValue value="123.45"/>
      </g:Obs>
      <g:Obs>
        <g:ObsDimension value="2021"/>
        <g:ObsValue value="200.0"/>
      </g:Obs>
    </g:Series>
  </g:DataSet>
</GenericData>
"""
    path = FIXTURES / "sample_generic.xml"
    path.write_text(xml, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Assertions.
# ---------------------------------------------------------------------------

def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def test_tabular_csv_wide_semicolon():
    path = _write_csv_fixture()
    data = path.read_bytes()
    rows = parse_tabular(data, SourceType.CSV, "file://" + str(path))

    # France and Germany over three years each, World kept as three world-total
    # rows, Total dropped. That is nine observations.
    _check(len(rows) == 9, f"expected 9 rows, got {len(rows)}")

    reshaped = [r for r in rows if "reshaped:wide-to-long" in r.flags]
    _check(len(reshaped) == 9, "every melted row should carry reshaped flag")

    world = [r for r in rows if "world-total" in r.flags]
    _check(len(world) == 3, f"expected 3 world-total rows, got {len(world)}")
    for r in world:
        _check(r.partner_name == "World", "world row partner_name must be World")
        _check(r.partner_iso3 is None, "world row partner_iso3 must be None")

    fr_2019 = [
        r for r in rows
        if r.partner_iso3 == "FRA" and r.year == 2019
    ]
    _check(len(fr_2019) == 1, "expected one France 2019 row")
    _check(
        abs(fr_2019[0].value - 100.5) < 1e-9,
        f"France 2019 value should be 100.5, got {fr_2019[0].value}",
    )

    # No Total row leaked through.
    _check(
        all("Total" not in (r.provenance.raw_value or "") for r in rows),
        "a total row leaked into the output",
    )
    # Currency is not stated in a column or header, so it must stay None.
    _check(all(r.currency is None for r in rows), "currency must not be invented")
    # Provenance row_index points at the physical source line, not a reshaped
    # index. France sits on source line 6 (zero based).
    _check(
        fr_2019[0].provenance.row_index == 6,
        f"France row_index should be 6, got {fr_2019[0].provenance.row_index}",
    )
    return rows


def test_tabular_excel_two_sheets():
    path = _write_excel_fixture()
    data = path.read_bytes()
    rows = parse_tabular(data, SourceType.EXCEL, "file://" + str(path))

    # Sheet 1: 2 partners x 3 years wide = 6. Sheet 2: 2 long rows. Total 8.
    _check(len(rows) == 8, f"expected 8 rows, got {len(rows)}")

    sheet1 = [r for r in rows if r.provenance.locator == "Exports2021"]
    sheet2 = [r for r in rows if r.provenance.locator == "Summary"]
    _check(len(sheet1) == 6, f"sheet 1 should yield 6 rows, got {len(sheet1)}")
    _check(len(sheet2) == 2, f"sheet 2 should yield 2 rows, got {len(sheet2)}")

    # Sheet 1 was pivoted, so those rows are reshaped.
    _check(
        all("reshaped:wide-to-long" in r.flags for r in sheet1),
        "sheet 1 rows should be reshaped",
    )
    # Sheet 2 header stated USD, so currency and value_usd are established.
    for r in sheet2:
        _check(r.currency == "USD", "sheet 2 currency should be USD")
        _check(r.value_usd == r.value, "USD value_usd should mirror value")
        _check(r.usd_basis == "reported", "usd_basis should be reported")
        _check(r.flow == "import", "sheet 2 flow should be import")

    # A specific value survives the round trip: US->France 2019 = 11.
    fr = [
        r for r in sheet1
        if r.partner_iso3 == "FRA" and r.year == 2019
    ]
    _check(len(fr) == 1 and fr[0].value == 11, "US France 2019 should be 11")
    # table_index reflects sheet position.
    _check(fr[0].provenance.table_index == 0, "sheet 1 table_index should be 0")
    _check(sheet2[0].provenance.table_index == 1, "sheet 2 table_index should be 1")
    return rows


def test_json_nested():
    path = _write_json_fixture()
    rows = parse_json(path.read_bytes(), "https://api.example.gov/trade")
    # Two real records under data; the footnote-only dict is skipped.
    _check(len(rows) == 2, f"expected 2 rows, got {len(rows)}")
    _check(rows[0].reporter_iso3 == "USA", "reporter should resolve to USA")
    _check(rows[0].partner_iso3 == "FRA", "partner should resolve to FRA")
    _check(abs(rows[0].value - 1234.5) < 1e-9, "value should be 1234.5")
    _check(rows[0].currency == "USD", "currency should be USD")
    _check(rows[0].value_usd == 1234.5, "value_usd should mirror value for USD")
    _check(rows[0].year == 2020, "year should be 2020")
    _check(rows[0].flow == "export", "flow should be export")
    _check(rows[0].provenance.locator == "$.data[0]", "locator should be JSON path")
    return rows


def test_json_columnar():
    path = _write_json_columnar_fixture()
    rows = parse_json(path.read_bytes(), "https://api.example.gov/columnar")
    _check(len(rows) == 2, f"expected 2 rows, got {len(rows)}")
    _check(rows[0].partner_iso3 == "FRA", "first partner should be FRA")
    _check(rows[0].value == 100, "first value should be 100")
    _check(rows[1].value == 200, "second value should be 200")
    return rows


def test_json_error_envelope():
    path = _write_json_error_fixture()
    rows = parse_json(path.read_bytes(), "https://api.example.gov/broken")
    _check(rows == [], "error envelope must yield no rows")
    return rows


def test_sdmx_json():
    path = FIXTURES / "sample_sdmx.json"
    _check(path.exists(), "sample_sdmx.json fixture is missing")
    rows = parse_sdmx(path.read_bytes(), "https://sdmx.example.org/data")
    _check(len(rows) == 2, f"expected 2 sdmx-json rows, got {len(rows)}")
    _check(all(r.reporter_iso3 == "USA" for r in rows), "reporter should be USA")
    years = sorted(r.year for r in rows)
    _check(years == [2020, 2021], f"years should be 2020 and 2021, got {years}")
    vals = sorted(r.value for r in rows)
    _check(
        abs(vals[0] - 123.45) < 1e-9 and abs(vals[1] - 200.0) < 1e-9,
        f"values should be 123.45 and 200.0, got {vals}",
    )
    return rows


def test_sdmx_ml_lxml_fallback():
    path = _write_sdmx_ml_fixture()
    rows = parse_sdmx(path.read_bytes(), "https://sdmx.example.org/generic")
    _check(len(rows) == 2, f"expected 2 sdmx-ml rows, got {len(rows)}")
    _check(
        all("sdmx:lxml-fallback" in r.flags for r in rows),
        "generic ML without a DSD should recover through the lxml fallback",
    )
    for r in rows:
        _check(r.reporter_iso3 == "USA", "reporter US should resolve to USA")
        _check(r.partner_iso3 == "FRA", "partner FR should resolve to FRA")
        _check(r.flow == "export", "flow EXP should resolve to export")
        _check(r.currency == "USD", "currency USD should carry through")
    years = sorted(r.year for r in rows)
    _check(years == [2020, 2021], f"sdmx-ml years should be 2020, 2021, got {years}")
    return rows


def test_sdmx_structure_is_empty():
    # A structure-only message states no facts. It must return empty, not error.
    xml = (
        b'<?xml version="1.0"?>'
        b'<mes:Structure '
        b'xmlns:mes="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message">'
        b"<mes:Header><mes:ID>X</mes:ID></mes:Header>"
        b"</mes:Structure>"
    )
    rows = parse_sdmx(xml, "https://sdmx.example.org/structure")
    _check(rows == [], "a structure-only message should yield no rows")
    return rows


def test_malformed_inputs_are_defensive():
    # Garbage never raises; it returns an empty list.
    _check(parse_json(b"\x00\x01 not json", "u") == [], "bad json should be empty")
    _check(parse_sdmx(b"not xml at all", "u") == [], "bad sdmx should be empty")
    tab = parse_tabular(b"\xff\xfe\x00random", SourceType.CSV, "u")
    _check(isinstance(tab, list), "bad tabular should return a list")


def test_tabular_header_scale():
    # A long CSV whose value column names its magnitude. The parser must pass the
    # header to parse_number_with_scale and record the returned note as a flag,
    # so the figure is not understated by the size of the word.
    lines = [
        "Reporter,Partner,Value (US$ thousand),Year",
        "United States,France,412300,2020",
    ]
    data = ("\n".join(lines)).encode("utf-8")
    rows = parse_tabular(data, SourceType.CSV, "u")
    _check(len(rows) == 1, f"expected 1 row, got {len(rows)}")
    r = rows[0]
    _check(
        abs(r.value - 412300000.0) < 1e-6,
        f"value should scale to 412300000.0, got {r.value}",
    )
    _check(
        "scale-from-header:thousand" in r.flags,
        f"scale flag missing, flags were {r.flags}",
    )
    # The raw cell is preserved untouched even though the stored value is scaled.
    _check(
        r.provenance.raw_value == "412300",
        f"raw_value should stay the cell text, got {r.provenance.raw_value!r}",
    )
    return rows


def _run_all():
    results = []
    tests = [
        ("tabular csv wide semicolon", test_tabular_csv_wide_semicolon),
        ("tabular header scale", test_tabular_header_scale),
        ("tabular excel two sheets", test_tabular_excel_two_sheets),
        ("json nested", test_json_nested),
        ("json columnar", test_json_columnar),
        ("json error envelope", test_json_error_envelope),
        ("sdmx json", test_sdmx_json),
        ("sdmx ml lxml fallback", test_sdmx_ml_lxml_fallback),
        ("sdmx structure empty", test_sdmx_structure_is_empty),
        ("malformed inputs", test_malformed_inputs_are_defensive),
    ]
    failed = 0
    for name, fn in tests:
        try:
            out = fn()
            count = len(out) if isinstance(out, list) else "ok"
            print(f"PASS  {name}  ({count} rows)")
            results.append((name, out))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {name}: {exc}")
    print()
    if failed:
        print(f"{failed} test(s) failed")
        return 1
    print("all parser tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(_run_all())
