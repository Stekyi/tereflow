"""Partner codes that are not a single country.

Comtrade reports some trade against areas it cannot attribute to one country: "areas, nes", bunkers, free zones
and groupings such as "Other Asia, nes". They carry real trade, so the figures stay in the totals, but they are
not a buyer, a supplier, a market or a currency. They are never named as a top partner or counted for
concentration, and they are described as what they are rather than shown as a raw code.

Mirror of shared/markets.ts. Codes can arrive with trailing spaces ("_X "), so every lookup strips first."""
from __future__ import annotations
import re

AREA_NAMES = {
    "WLD": "World",
    "S19": "Other Asia, not elsewhere specified",
    "_X": "Areas, not elsewhere specified",
    "XX": "Special categories",
    "X1": "Special categories (1)",
    "X2": "Special categories (2)",
    "E19": "Europe, not elsewhere specified",
    "F19": "Free zones",
    "A79": "Western Asia, not elsewhere specified",
    "O19": "Oceania, not elsewhere specified",
    "A59": "Other areas, not elsewhere specified",
}
_ISO3 = re.compile(r"^[A-Z]{3}$")

# The same rule as is_market(), as a SQL condition on f.partner_iso3, so a query can drop the areas BEFORE it
# ranks or counts partners. Filtering afterwards would let areas take slots in a top-N and crowd real countries out.
_AREA_LIST = ", ".join(f"'{c}'" for c in AREA_NAMES)
REAL_COUNTRY_SQL = f"(REGEXP_LIKE(TRIM(f.partner_iso3), '^[A-Z]{{3}}$') AND TRIM(f.partner_iso3) NOT IN ({_AREA_LIST}))"


def clean(code) -> str:
    return (code or "").strip()


def is_market(code) -> bool:
    c = clean(code)
    return bool(_ISO3.match(c)) and c not in AREA_NAMES


def partner_name(code, country_names: dict) -> str:
    c = clean(code)
    if not c:
        return "Unspecified"
    return country_names.get(c) or AREA_NAMES.get(c) or f"Unrecognised area ({c})"
