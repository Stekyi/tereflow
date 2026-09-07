"""Integration check against the real normalize modules.

The unit suite injects deterministic stub normalize modules so it tests the
parser logic in isolation. This script does the opposite: it imports the
parsers with no stubs at all, so the genuine tereflow_extract.normalize package
written by the other worker is what resolves. It proves the two halves wire
together (country resolution, currency detection, header mapping, year parsing)
and that the documented helper signatures actually hold on disk.

Run it with the venv python. It needs no network.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Put the package root on sys.path without importing test_parsers, because that
# module installs stub normalize modules on import and would defeat the point.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tereflow_extract.contracts import SourceType
from tereflow_extract.parsers.tabular import parse_tabular
from tereflow_extract.parsers.api_json import parse_json


def _fail(msg: str) -> None:
    raise AssertionError(msg)


def check_tabular() -> None:
    # A plain long CSV that names a country, a flow, a currency and a year, so
    # every real helper has something concrete to resolve.
    csv = (
        "Reporter,Partner,Flow,Value,Currency,Year\n"
        "United States,France,Export,1000,USD,2020\n"
        "United States,Germany,Export,2500,USD,2020\n"
    ).encode("utf-8")
    rows = parse_tabular(csv, SourceType.CSV, "mem://real.csv")
    if len(rows) != 2:
        _fail(f"expected 2 rows from real modules, got {len(rows)}")

    us = rows[0]
    print(
        "  tabular:",
        f"reporter_iso3={us.reporter_iso3}",
        f"partner_iso3={us.partner_iso3}",
        f"flow={us.flow}",
        f"currency={us.currency}",
        f"value_usd={us.value_usd}",
        f"usd_basis={us.usd_basis}",
        f"year={us.year}",
    )
    if us.reporter_iso3 != "USA":
        _fail(f"real resolve_country should map United States to USA, got {us.reporter_iso3}")
    if us.partner_iso3 != "FRA":
        _fail(f"real resolve_country should map France to FRA, got {us.partner_iso3}")
    if us.currency != "USD":
        _fail(f"real detect_currency should read USD column, got {us.currency}")
    # Currency was stated as USD, so and only so the parser may set value_usd.
    if us.value_usd != 1000.0 or us.usd_basis != "reported":
        _fail(f"USD basis wiring failed: value_usd={us.value_usd} basis={us.usd_basis}")
    if us.year != 2020:
        _fail(f"real parse_year should read 2020, got {us.year}")
    # Confidence and its breakdown stay owned by a later scoring stage; the
    # parser leaves confidence at 0.0 and the breakdown at its empty default.
    if us.confidence != 0.0:
        _fail(f"parser must not set confidence, got {us.confidence}")


def check_json() -> None:
    data = (
        b'{"data":[{"reporter":"United States","partner":"Canada",'
        b'"flow":"Import","value":"500","currency":"USD","year":"2021"}]}'
    )
    rows = parse_json(data, "mem://real.json")
    if len(rows) != 1:
        _fail(f"expected 1 json row from real modules, got {len(rows)}")
    r = rows[0]
    print(
        "  json:   ",
        f"reporter_iso3={r.reporter_iso3}",
        f"partner_iso3={r.partner_iso3}",
        f"flow={r.flow}",
        f"currency={r.currency}",
        f"year={r.year}",
    )
    if r.reporter_iso3 != "USA":
        _fail(f"json reporter should resolve to USA, got {r.reporter_iso3}")
    if r.value != 500.0:
        _fail(f"json value should be 500.0, got {r.value}")


def main() -> int:
    import tereflow_extract.normalize as real

    where = getattr(real, "__file__", None) or getattr(real, "__path__", None)
    print(f"using real normalize package at: {where}")
    check_tabular()
    check_json()
    print("real-normalize integration check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
