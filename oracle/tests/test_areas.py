"""Unattributed trade areas must never be a supplier.   python oracle/tests/test_areas.py

Pure checks, no database. The same defect class as the false 0% tariff: a source's placeholder value was being
treated as a real entity, here a catch-all area counted as a country."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tereflow_oracle.markets import is_market, partner_name, REAL_COUNTRY_SQL, AREA_NAMES  # noqa: E402
from tereflow_oracle.opportunity import compute_metrics, YearTotal  # noqa: E402

# classification, including the trailing-space codes Comtrade produces
for real in ("USA", "NLD", "JPN", "GHA", "GIB", " CHN "):
    assert is_market(real), real
for area in ("S19", "_X", "_X ", "X1 ", "XX ", "E19", "F19", "A79", "O19", "A59", "WLD", "", None, "  "):
    assert not is_market(area), repr(area)

# honest names, never a raw code that looks like a place
names = {"USA": "United States"}
assert partner_name("USA", names) == "United States"
assert partner_name("S19", names) == "Other Asia, not elsewhere specified"
assert partner_name("_X ", names) == "Areas, not elsewhere specified"
assert partner_name("QQQ", names) == "Unrecognised area (QQQ)"
assert partner_name(None, names) == "Unspecified"

# the SQL condition names every area, so a query can drop them before ranking
for code in AREA_NAMES:
    assert f"'{code}'" in REAL_COUNTRY_SQL, code
assert "{3}" in REAL_COUNTRY_SQL

# China imports: 230 of 300 is "Other Asia, nes". It must not be the top supplier or inflate concentration.
y = YearTotal(2025, 300.0, None, {"S19": 230.0, "JPN": 40.0, "KOR": 30.0})
m = compute_metrics("CHN", "M", "HS6", "854231", "chips", [y])
assert m.top_partner == "JPN", m.top_partner
assert round(m.top_share, 1) == 13.3, m.top_share          # share of ALL trade, not of the attributed part
assert m.partner_count == 2
# concentration is among real suppliers: (40/70)^2 + (30/70)^2 = 0.5102, not diluted by the area
assert round(m.hhi, 3) == 0.510, m.hhi
assert any("not a single country" in line for line in m.limitations), m.limitations

# when the area is small nothing is added and the result matches a plain country-only product
y2 = YearTotal(2025, 100.0, None, {"USA": 60.0, "DEU": 30.0, "S19": 10.0})
m2 = compute_metrics("GHA", "X", "HS6", "180100", "cocoa", [y2])
assert m2.top_partner == "USA" and m2.partner_count == 2
assert not any("not a single country" in line for line in m2.limitations)

# only areas reported: nobody is a supplier
y3 = YearTotal(2025, 50.0, None, {"_X ": 50.0})
m3 = compute_metrics("TGO", "X", "HS6", "999999", "x", [y3])
assert m3.top_partner is None and m3.partner_count == 0 and m3.hhi is None

# padded codes are cleaned before they are named
y4 = YearTotal(2025, 100.0, None, {"USA ": 70.0, "DEU": 30.0})
assert compute_metrics("GHA", "X", "HS6", "1", "x", [y4]).top_partner == "USA"

print("areas: all invariants hold")
