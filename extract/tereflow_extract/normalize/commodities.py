"""
Commodity codes and what they are called.

The Harmonised System is the one identifier that travels between sources, so
recognising it is worth doing carefully. The traps are all about length.

An HS code is 2, 4 or 6 digits, and the length is the level: chapter, heading,
subheading. Sources print them in every possible way. "0901", "09.01", "0901.11",
"090111", "HS 0901" all appear, and some national tariff lines run to 8 or 10
digits where the last digits are a national extension that is not comparable
across countries.

The rule that matters most is elsewhere in this project and is worth repeating
here: a chapter and its subheadings describe the same trade at different
granularities, so matching `hs_code LIKE '09%'` picks up both and doubles the
money. This module therefore always records the level explicitly, so nothing
downstream has to infer it from string length.
"""

from __future__ import annotations

import re

# A code with its own separators. Two shapes appear: 09.01.11 (grouped in
# twos) and 0901.11 (heading, then subheading digits), and both are common.
_DOTTED = re.compile(
    r"\b(?:"
    r"(\d{4})[.\-\s](\d{2})(?:[.\-\s](\d{2,4}))?"   # 0901.11 or 0901.11.00
    r"|(\d{2})[.\-\s](\d{2})(?:[.\-\s](\d{2}))?(?:[.\-\s](\d{2,4}))?"  # 09.01.11
    r")\b"
)
# A bare run of digits that could be a code
_BARE = re.compile(r"\b(\d{2}|\d{4}|\d{6}|\d{8}|\d{10})\b")
# An explicit label, which is the strongest signal there is
_LABELLED = re.compile(
    r"\b(?:HS|H\.S\.|SH|NC|CN|SITC|NCM|TARIC)\s*[:\-]?\s*(\d{2}(?:[.\-\s]?\d{2}){0,4})\b",
    re.IGNORECASE,
)

# Chapter numbers that exist. 77 is reserved and 98/99 are national use, so a
# code starting with them is not a comparable HS line.
VALID_CHAPTERS = set(range(1, 98)) - {77}


def hs_level(code: str) -> str | None:
    """chapter, heading, subheading or national, from the digit count."""
    n = len(code)
    if n == 2:
        return "chapter"
    if n == 4:
        return "heading"
    if n == 6:
        return "subheading"
    if n in (8, 10):
        return "national"
    return None


def valid_hs(code: str) -> bool:
    """Whether a digit string could be a real HS code."""
    if not code.isdigit():
        return False
    if hs_level(code) is None:
        return False
    try:
        chapter = int(code[:2])
    except ValueError:
        return False
    return chapter in VALID_CHAPTERS


def parse_hs(text: str | None) -> tuple[str | None, float]:
    """
    Pull an HS code out of a label, or decline.

    Returns (code, confidence). The code keeps its original length, because
    truncating an 8-digit national line to 6 would silently claim it is the
    internationally comparable subheading when it is not.

    Confidence:
      1.00  explicitly labelled, "HS 0901.11"
      0.90  dotted form, which is only used for codes
      0.70  a bare run of digits in a field that also carries a description
      0.00  nothing, or a number that is not a plausible code

    A bare 4-digit number is deliberately weak: 2019 is a year, 1000 is a
    quantity, and both would pass a naive digit test.
    """
    if not text:
        return None, 0.0

    s = str(text).strip()

    m = _LABELLED.search(s)
    if m:
        digits = re.sub(r"\D", "", m.group(1))
        if valid_hs(digits):
            return digits, 1.0

    m = _DOTTED.search(s)
    if m:
        digits = "".join(g for g in m.groups() if g)
        if valid_hs(digits):
            return digits, 0.9

    # A bare number is only a code if something else in the field looks like a
    # product description. "0901 Coffee" is a code; "2019" on its own is a year.
    for m in _BARE.finditer(s):
        digits = m.group(1)
        if not valid_hs(digits):
            continue
        if len(digits) == 4 and _looks_like_year(digits):
            continue
        remainder = (s[: m.start()] + s[m.end():]).strip(" .,:;-")
        if len(remainder) >= 3 and any(ch.isalpha() for ch in remainder):
            return digits, 0.7
        if len(digits) >= 6:
            # Six or more digits is not a year and rarely a quantity.
            return digits, 0.7

    return None, 0.0


def _looks_like_year(digits: str) -> bool:
    """Whether a 4-digit run is more plausibly a year than a heading."""
    n = int(digits)
    return 1900 <= n <= 2099


def split_code_and_name(text: str | None) -> tuple[str | None, str | None]:
    """
    Separate "0901 Coffee, whether or not roasted" into its parts.

    Statistical tables very often print the two together in one cell, and
    keeping the code inside the product name makes the name useless for
    matching and display.
    """
    if not text:
        return None, None
    s = str(text).strip()

    code, conf = parse_hs(s)
    if not code or conf < 0.7:
        return None, s or None

    # Remove the first occurrence of the code in whatever form it was printed.
    pattern = re.compile(
        r"^\s*(?:HS|H\.S\.|SH|NC|CN)?\s*[:\-]?\s*"
        + r"[.\-\s]?".join(code[i:i + 2] for i in range(0, len(code), 2))
        + r"\s*[:\-]?\s*",
        re.IGNORECASE,
    )
    name = pattern.sub("", s, count=1).strip(" .,:;-")
    return code, (name or None)


# Words that mean a row is a total rather than a product. Summing a table that
# contains its own total double counts everything in it.
TOTAL_TOKENS = {
    "total", "totals", "all products", "all commodities", "all goods",
    "grand total", "sub-total", "subtotal", "sum", "overall",
    "total trade", "total exports", "total imports", "all items",
    "todos", "total general", "insgesamt", "gesamt", "totale",
}


def is_total_row(label: str | None) -> bool:
    """Whether a product label marks a total rather than a line of goods."""
    if not label:
        return False
    s = re.sub(r"\s+", " ", str(label).strip().lower())
    s = s.strip(" .,:;*")
    if s in TOTAL_TOKENS:
        return True
    # "Total exports of goods" and similar, but not "Total Petroleum Products"
    # which is a real commodity grouping.
    return bool(re.match(r"^(?:grand\s+)?totals?\b(?:\s+(?:of|for)\b)?\s*$", s))
