"""
End to end, on files rather than on the network.

Network tests prove a source is reachable today. These prove the pipeline does
the right thing with what comes back, which is the part that has to keep
working. Each case here is a shape seen in the real registry:

  a spreadsheet with a preamble before the header
  a European table using comma decimals
  a table priced in a currency that is not dollars
  a JSON API response with the records buried
  a page of HTML that is not the CSV it was registered as

The assertions are about refusals as much as extractions. A pipeline that finds
facts is easy; one that declines to invent them under pressure is the point.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tereflow_extract.confidence import score  # noqa: E402
from tereflow_extract.contracts import SourceType  # noqa: E402
from tereflow_extract.detect import classify  # noqa: E402
from tereflow_extract.emit import partition, to_fact  # noqa: E402
from tereflow_extract.parsers.api_json import parse_json  # noqa: E402
from tereflow_extract.parsers.tabular import parse_tabular  # noqa: E402

PASS = "  PASS  "
FAIL = "  FAIL  "
_results: list[bool] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    _results.append(ok)
    print(f"{PASS if ok else FAIL}{label}{(' - ' + detail) if detail else ''}")


# A real shape: title rows, a blank line, then the header. Ghana Statistical
# Service, INEGI and Eurostat exports all look like this.
CSV_WITH_PREAMBLE = b"""Ghana Statistical Service
External Trade Statistics
Prepared 2026-01-14

Partner country,HS Code,Commodity,Value (US$ thousand),Year,Flow
Netherlands,180100,Cocoa beans,412300,2024,Export
Switzerland,180100,Cocoa beans,298450,2024,Export
India,710812,Gold unwrought,1204500,2024,Export
Total,,,1915250,2024,Export
"""

# Semicolons and comma decimals, which is how most of continental Europe
# publishes. Read with English assumptions every value is a thousand times out.
CSV_EUROPEAN = b"""Land;Warenbezeichnung;Wert (Millionen Euro);Jahr;Richtung
Frankreich;Kaffee;1.234,5;2024;Ausfuhr
Italien;Kakao;987,25;2024;Ausfuhr
"""

# Money that is real but is not dollars. These must survive extraction and then
# be held back, with the value intact.
CSV_NON_USD = b"""Partner,Commodity,Value (GHS million),Year,Flow
Nigeria,Cocoa paste,4520,2024,Export
Togo,Cocoa paste,1180,2024,Export
"""

# Records nested under a key, which is how most statistical APIs answer.
JSON_NESTED = json.dumps(
    {
        "meta": {"page": 1, "total": 2},
        "data": [
            {
                "reporter": "Ghana", "partner": "Netherlands", "flow": "Export",
                "commodity": "Cocoa beans", "hs_code": "180100",
                "value": 412300000, "currency": "USD", "year": 2024,
            },
            {
                "reporter": "Ghana", "partner": "Switzerland", "flow": "Export",
                "commodity": "Cocoa beans", "hs_code": "180100",
                "value": 298450000, "currency": "USD", "year": 2024,
            },
        ],
    }
).encode()

# What most sources registered as csv actually return.
HTML_LANDING = b"""<!doctype html><html><head><title>Trade data</title></head>
<body><h1>External trade</h1>
<p>Download the full dataset below.</p>
<a href="/files/trade-2024.csv">Download CSV</a>
</body></html>"""


def main() -> int:
    print("\nExtraction pipeline, offline\n")

    print("Detection")
    t, ev = classify("https://x.test/data.csv", "text/csv", CSV_WITH_PREAMBLE, "csv")
    check("a real CSV is read as CSV", t is SourceType.CSV, t.value)

    t, ev = classify("https://x.test/data.csv", "text/html", HTML_LANDING, "csv")
    check(
        "a page registered as csv is read as HTML, not CSV",
        t is SourceType.HTML_STATIC,
        f"{t.value}; {', '.join(ev)}",
    )
    check(
        "the disagreement with the registry is recorded",
        any(e.startswith("override:") for e in ev),
    )

    t, _ = classify("https://x.test/q", None, JSON_NESTED, "api")
    check("JSON is read from its opening brace", t is SourceType.JSON, t.value)

    print("\nTabular, with a preamble")
    rows = parse_tabular(CSV_WITH_PREAMBLE, SourceType.CSV, "https://x.test/a.csv")
    for r in rows:
        score(r)
    check("the header was found under three title rows", len(rows) >= 3, f"{len(rows)} rows")

    if rows:
        cocoa = [r for r in rows if r.hs_code == "180100"]
        check("HS codes survive the round trip", len(cocoa) >= 2, f"{len(cocoa)} cocoa rows")
        nl = next((r for r in rows if (r.partner_name or "").startswith("Netherland")), None)
        check("the partner resolves to a country code", nl is not None and nl.partner_iso3 == "NLD",
              nl.partner_iso3 if nl else "not found")
        check(
            "the header scale of thousands was applied",
            nl is not None and nl.value is not None and nl.value >= 4.1e8,
            f"{nl.value if nl else None}",
        )
        check(
            "the total row was not emitted as a product",
            not any((r.product_name or "").strip().lower() == "total" for r in rows),
        )
        check("provenance names the row it came from",
              all(r.provenance is not None and r.provenance.row_index is not None for r in rows))

    print("\nTabular, European conventions")
    rows_eu = parse_tabular(CSV_EUROPEAN, SourceType.CSV, "https://x.test/eu.csv")
    for r in rows_eu:
        score(r)
    check("semicolon delimited file parsed", len(rows_eu) >= 2, f"{len(rows_eu)} rows")
    if rows_eu:
        fr = rows_eu[0]
        check(
            "comma decimal read as 1234.5 not 12345",
            fr.value is not None and abs(fr.value - 1.2345e9) < 1e6,
            f"{fr.value}",
        )
        check("currency read as EUR, not assumed USD", fr.currency == "EUR", str(fr.currency))
        check("no USD value was invented for a euro figure", fr.value_usd is None)

    print("\nNon-USD is kept, not converted and not dropped")
    rows_ghs = parse_tabular(CSV_NON_USD, SourceType.CSV, "https://x.test/ghs.csv")
    for r in rows_ghs:
        r.reporter_iso3 = r.reporter_iso3 or "GHA"
        score(r)
    facts, held = partition(rows_ghs, "test")
    check("no cedi row became a fact", len(facts) == 0, f"{len(facts)} facts")
    check("every cedi row was held instead", len(held) == len(rows_ghs), f"{len(held)} held")
    if held:
        check("held for the right reason", held[0].verdict.value == "non_usd", held[0].verdict.value)
        check("the real value survived being held", held[0].value is not None, str(held[0].value))
        check("the currency survived being held", held[0].currency == "GHS", str(held[0].currency))

    print("\nJSON with nested records")
    rows_json = parse_json(JSON_NESTED, "https://x.test/api")
    for r in rows_json:
        score(r)
    check("records found under a nested key", len(rows_json) == 2, f"{len(rows_json)} rows")
    if rows_json:
        f0 = to_fact(rows_json[0], "test")
        check("a complete USD row becomes a fact", f0 is not None,
              rows_json[0].verdict.value if rows_json[0].verdict else "?")
        if f0:
            check("the fact carries every column D1 requires",
                  all(getattr(f0, k) is not None for k in ("year", "flow", "stream", "value_usd", "source_ref")))

    print("\nRefusals")
    from tereflow_extract.contracts import Extraction, Provenance

    naked = Extraction(value=100.0, currency="USD", year=2024, flow="export")
    score(naked)
    check("a row with no reporting country cannot be a fact",
          to_fact(naked, "test") is None, naked.verdict.value)

    no_year = Extraction(value=100.0, currency="USD", flow="export", reporter_iso3="GHA",
                         value_usd=100.0, usd_basis="reported")
    score(no_year)
    check("a row with no year cannot be a fact",
          to_fact(no_year, "test") is None, no_year.verdict.value)

    silly = Extraction(value=9.9e15, currency="USD", year=2024, flow="export",
                       reporter_iso3="GHA", value_usd=9.9e15, usd_basis="reported",
                       provenance=Provenance("u", SourceType.CSV, "t"))
    score(silly)
    check("an impossible magnitude is refused", to_fact(silly, "test") is None, silly.verdict.value)

    ocr = Extraction(value=100.0, currency="USD", year=2024, flow="export",
                     reporter_iso3="GHA", value_usd=100.0, usd_basis="reported",
                     hs_code="180100", product_name="Cocoa",
                     provenance=Provenance("u", SourceType.PDF_SCANNED, "ocr"),
                     flags=["ocr:ambiguous-digit"])
    score(ocr)
    check("an ambiguous OCR digit caps the score",
          ocr.confidence <= 0.40, f"confidence {ocr.confidence}")
    check("and that row is held back", to_fact(ocr, "test") is None,
          ocr.verdict.value if ocr.verdict else "?")

    passed = sum(1 for r in _results if r)
    print(f"\n{passed}/{len(_results)} passed\n")
    return 0 if passed == len(_results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
