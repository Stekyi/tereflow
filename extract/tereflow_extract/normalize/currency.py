"""
Which currency a figure is in, and never a conversion.

This module identifies. It does not convert, and that is a deliberate limit
rather than an unfinished feature.

Converting GHS to USD needs a rate, and a rate needs a date, because the cedi
moved about forty percent against the dollar during 2022 alone. A pipeline that
carried one hardcoded rate would produce figures that were quietly wrong by
that much, and would keep producing them long after anyone remembered where the
rate came from. There is no free, reliable, historical, daily FX source that
can be depended on here, so the honest thing is to keep the currency the source
stated and let a figure in cedis stay a figure in cedis.

What that means downstream: `trade_facts.value_usd` is NOT NULL, so a non-USD
row cannot enter it. Those rows are quarantined with the reason `non_usd` and
their real value and currency are preserved, ready for the day a dated rate
table exists.
"""

from __future__ import annotations

import re

# Symbols that belong to exactly one currency. The ambiguous ones are handled
# separately below, because getting them wrong changes the number.
UNAMBIGUOUS_SYMBOLS: dict[str, str] = {
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
    "₹": "INR",
    "₦": "NGN",
    "₵": "GHS",
    "₽": "RUB",
    "₩": "KRW",
    "₪": "ILS",
    "₺": "TRY",
    "₴": "UAH",
    "₫": "VND",
    "฿": "THB",
    "₱": "PHP",
    "₡": "CRC",
    "₸": "KZT",
    "₭": "LAK",
    "₮": "MNT",
    "﷼": "IRR",
    "៛": "KHR",
    "₲": "PYG",
    "₼": "AZN",
    "₾": "GEL",
    "R$": "BRL",
    "RM": "MYR",
    "Rp": "IDR",
    "GH¢": "GHS",
    "GHS": "GHS",
    "US$": "USD",
    "USD": "USD",
    "U$S": "USD",
}

# A bare dollar sign is not a currency. More than twenty countries print their
# money with it, and reading a Zimbabwean or Canadian figure as US dollars is
# exactly the silent error this pipeline exists to avoid. It only resolves when
# something nearby says which dollar.
DOLLAR_QUALIFIERS: dict[str, str] = {
    "us": "USD",
    "u.s.": "USD",
    "usd": "USD",
    "united states": "USD",
    "can": "CAD",
    "cad": "CAD",
    "canadian": "CAD",
    "aud": "AUD",
    "australian": "AUD",
    "nzd": "NZD",
    "new zealand": "NZD",
    "hkd": "HKD",
    "hong kong": "HKD",
    "sgd": "SGD",
    "singapore": "SGD",
    "twd": "TWD",
    "ntd": "TWD",
    "taiwan": "TWD",
    "jmd": "JMD",
    "jamaican": "JMD",
    "ttd": "TTD",
    "trinidad": "TTD",
    "bbd": "BBD",
    "barbados": "BBD",
    "nad": "NAD",
    "namibian": "NAD",
    "zwl": "ZWL",
    "zimbabwe": "ZWL",
    "fjd": "FJD",
    "fiji": "FJD",
    "xcd": "XCD",
    "caribbean": "XCD",
    "bnd": "BND",
    "brunei": "BND",
    "gyd": "GYD",
    "guyana": "GYD",
    "srd": "SRD",
    "suriname": "SRD",
    "bzd": "BZD",
    "belize": "BZD",
    "lrd": "LRD",
    "liberian": "LRD",
}

# The same problem for other shared symbols and words.
KRONA_QUALIFIERS = {"sek": "SEK", "swedish": "SEK", "nok": "NOK", "norwegian": "NOK",
                    "dkk": "DKK", "danish": "DKK", "isk": "ISK", "icelandic": "ISK"}
FRANC_QUALIFIERS = {"chf": "CHF", "swiss": "CHF", "xof": "XOF", "cfa": "XOF",
                    "west african": "XOF", "xaf": "XAF", "central african": "XAF"}
RAND_QUALIFIERS = {"zar": "ZAR", "south african": "ZAR"}
POUND_QUALIFIERS = {"egp": "EGP", "egyptian": "EGP", "sdg": "SDG", "sudanese": "SDG",
                    "lbp": "LBP", "lebanese": "LBP", "syp": "SYP", "syrian": "SYP",
                    "gbp": "GBP", "sterling": "GBP", "british": "GBP"}

# Three-letter codes seen in these sources, checked against a word boundary so
# "CAN" in "CANADA" does not read as Canadian dollars.
COMMON_CODES = {
    "USD", "EUR", "GBP", "JPY", "CNY", "RMB", "INR", "CHF", "CAD", "AUD", "NZD",
    "ZAR", "NGN", "GHS", "KES", "TZS", "UGX", "EGP", "MAD", "XOF", "XAF", "BRL",
    "MXN", "ARS", "CLP", "COP", "PEN", "UYU", "SEK", "NOK", "DKK", "PLN", "CZK",
    "HUF", "RON", "TRY", "RUB", "UAH", "AED", "SAR", "QAR", "KWD", "ILS", "SGD",
    "HKD", "KRW", "TWD", "THB", "MYR", "IDR", "PHP", "VND", "PKR", "BDT", "LKR",
}

_CODE_RE = re.compile(r"\b(" + "|".join(sorted(COMMON_CODES)) + r")\b")

_EURO_WORDS = re.compile(r"\beuros?\b", re.IGNORECASE)
_USD_WORDS = re.compile(
    r"\b(?:us\s*dollars?|u\.?s\.?\s*dollars?|united\s+states\s+dollars?)\b", re.IGNORECASE
)


def detect_currency(text: str | None) -> tuple[str | None, float]:
    """
    Identify the currency a figure is stated in.

    Returns the ISO 4217 code and a confidence between 0 and 1. None means no
    currency could be established, which is not the same as dollars: the caller
    must treat it as unknown, and a row whose currency is unknown cannot claim
    to carry a USD value.

    Confidence is graded by how direct the evidence was:
      1.00  explicit ISO code, or a symbol belonging to one currency
      0.90  a qualified shared symbol, "US$" or "Canadian dollar"
      0.70  a currency word without a qualifier where only one reading is
            plausible in context
      0.00  nothing found, or a bare shared symbol with no qualifier
    """
    if not text:
        return None, 0.0

    s = str(text)
    low = s.lower()

    # Compound symbols first: "US$" must beat a bare "$".
    for sym in sorted(UNAMBIGUOUS_SYMBOLS, key=len, reverse=True):
        if sym in s or (len(sym) > 1 and sym.lower() in low):
            return UNAMBIGUOUS_SYMBOLS[sym], 1.0

    m = _CODE_RE.search(s.upper())
    if m:
        code = m.group(1)
        return ("CNY" if code == "RMB" else code), 1.0

    if _USD_WORDS.search(s):
        return "USD", 0.9
    if _EURO_WORDS.search(s):
        return "EUR", 0.9

    # Shared symbols and words, resolved only by a qualifier.
    if "$" in s:
        resolved = _qualify(low, DOLLAR_QUALIFIERS)
        if resolved:
            return resolved, 0.9
        return None, 0.0  # a bare dollar sign settles nothing

    if "dollar" in low:
        resolved = _qualify(low, DOLLAR_QUALIFIERS)
        return (resolved, 0.9) if resolved else (None, 0.0)

    if "kr" in low or "krona" in low or "krone" in low:
        resolved = _qualify(low, KRONA_QUALIFIERS)
        return (resolved, 0.9) if resolved else (None, 0.0)

    if "franc" in low or "fr." in low:
        resolved = _qualify(low, FRANC_QUALIFIERS)
        return (resolved, 0.9) if resolved else (None, 0.0)

    if "rand" in low:
        resolved = _qualify(low, RAND_QUALIFIERS)
        return (resolved, 0.9) if resolved else (None, 0.0)

    if "pound" in low or "£" in s:
        resolved = _qualify(low, POUND_QUALIFIERS)
        return (resolved, 0.9) if resolved else ("GBP", 0.7)

    if "yuan" in low or "renminbi" in low:
        return "CNY", 0.9
    if "yen" in low:
        return "JPY", 0.9
    if "rupee" in low:
        # Several countries have rupees and they are worth very different
        # amounts, so this needs a qualifier like the dollar does.
        for token, code in (("indian", "INR"), ("pakistan", "PKR"),
                            ("sri lanka", "LKR"), ("nepal", "NPR"),
                            ("mauriti", "MUR"), ("seychell", "SCR")):
            if token in low:
                return code, 0.9
        return None, 0.0
    if "cedi" in low:
        return "GHS", 0.95
    if "naira" in low:
        return "NGN", 0.95
    if "shilling" in low:
        for token, code in (("kenya", "KES"), ("tanzania", "TZS"),
                            ("uganda", "UGX"), ("somali", "SOS")):
            if token in low:
                return code, 0.9
        return None, 0.0

    return None, 0.0


def _qualify(low: str, table: dict[str, str]) -> str | None:
    """Longest qualifier wins, so 'new zealand' beats a stray 'nz'."""
    for token in sorted(table, key=len, reverse=True):
        if token in low:
            return table[token]
    return None


def is_usd(code: str | None) -> bool:
    return code == "USD"


def usd_value(value: float | None, currency: str | None) -> tuple[float | None, str | None]:
    """
    The USD figure for a value, where one exists without conversion.

    Returns (value, 'reported') only when the source already stated dollars.
    Everything else returns (None, None), and the caller quarantines the row
    rather than converting it. See the module docstring for why there is no
    conversion here.
    """
    if value is None:
        return None, None
    if is_usd(currency):
        return value, "reported"
    return None, None
