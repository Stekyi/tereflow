"""
Turning printed numbers into numbers.

Trade statistics are published by national agencies in their own local
conventions, and the conventions conflict. `1.234,56` is one thousand two
hundred in Germany and Brazil. `1,234.56` is the same amount in the UK and the
US. `1 234,56` is the same again in France, with a non-breaking space that does
not match `\\s` in some encodings. Getting this wrong by a factor of a thousand
is silent and survives every downstream check.

So this module refuses more often than it guesses. Where a string is genuinely
ambiguous and reading it one way rather than the other changes the value, it
returns None and lets the caller record that the cell could not be read. A
missing figure is recoverable. A figure that is wrong by 1000x is not, because
nothing downstream will ever question it.
"""

from __future__ import annotations

import math
import re

# Words that multiply. Only ones with a single unambiguous meaning are here.
#
# "billion" is 1e9 everywhere that publishes in English today, including the UK
# which abandoned the long scale officially in 1974. Sources old enough to mean
# 1e12 are not in this registry.
#
# "lakh" and "crore" are South Asian and unambiguous where they appear.
# "milliard" is 1e9 in the European languages that use it.
MAGNITUDE: dict[str, float] = {
    "hundred": 1e2,
    "thousand": 1e3,
    "k": 1e3,
    "lakh": 1e5,
    "lac": 1e5,
    "million": 1e6,
    "mn": 1e6,
    "mln": 1e6,
    "crore": 1e7,
    "billion": 1e9,
    "bn": 1e9,
    "milliard": 1e9,
    "trillion": 1e12,
    "tn": 1e12,
    # The same words in the other languages these sources publish in. Without
    # these a German or Spanish table reads a million times too small, which is
    # the same class of silent error as a misread separator.
    "tausend": 1e3,
    "mil": 1e3,
    "millionen": 1e6,
    "millones": 1e6,
    "milhões": 1e6,
    "milhoes": 1e6,
    "millioner": 1e6,
    "miljoner": 1e6,
    "milione": 1e6,
    "milioni": 1e6,
    "milion": 1e6,
    "miliony": 1e6,
    "millions": 1e6,
    "milliers": 1e3,
    "miljoen": 1e6,
    "milliarden": 1e9,
    "millardos": 1e9,
    "miliardo": 1e9,
    "miliard": 1e9,
    "miljard": 1e9,
    "billions": 1e9,
    "mrd": 1e9,
}

_SCIENTIFIC_RE = re.compile(r"[-+]?\d+(?:\.\d+)?[eE][-+]?\d+")

_MAGNITUDE_RE = re.compile(
    r"\b(" + "|".join(sorted(MAGNITUDE, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)

# The language a magnitude word is written in tells you which convention the
# number beside it follows, and that is real evidence rather than a guess.
# "1,204 million" in an English document is 1204 million, because English uses
# the comma for grouping. "1,204 Millionen" in a German one is 1.204 million,
# because German uses it for the decimal point. Knowing which language the
# document is in resolves the case that is otherwise unreadable.
DOT_DECIMAL_WORDS = {
    "hundred", "thousand", "million", "billion", "trillion",
    "lakh", "lac", "crore", "mn", "bn", "tn", "mln", "k",
}
COMMA_DECIMAL_WORDS = {
    "millionen", "milliarden", "tausend",        # German
    "millones", "millardos", "mil millones",     # Spanish
    "milhões", "milhoes", "milhares",            # Portuguese
    "millioner", "miljoner", "miljard",          # Nordic and Dutch
    "milione", "milioni", "miliardo",            # Italian
    "milion", "miliony", "miliard",              # Polish and Czech
}
_COMMA_DECIMAL_RE = re.compile(
    r"\b(" + "|".join(sorted(COMMA_DECIMAL_WORDS, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)

# Currencies whose documents are written in a dot-decimal convention. Seeing
# one of these beside a number is weaker evidence than a magnitude word but is
# still evidence, and it is the difference between reading a figure and
# refusing it.
DOT_DECIMAL_CURRENCY = re.compile(
    r"(?:\bUS\s*\$|\bUSD\b|\bGBP\b|\bAUD\b|\bCAD\b|\bNZD\b|\bHKD\b|\bSGD\b"
    r"|\bINR\b|\bGHS\b|\bNGN\b|\bKES\b|\bZAR\b|\bJPY\b|\bCNY\b|\bMYR\b"
    r"|\bPHP\b|GH¢|₵|₦|₹|£|¥)",
    re.IGNORECASE,
)

# Cells that say "no data" rather than "zero". Treating these as 0 would put a
# fabricated zero into the record, which is worse than an absent value because
# a zero looks deliberate.
NULL_TOKENS = {
    "",
    "-",
    "--",
    "---",
    "..",
    "...",
    "....",
    ":",
    "n/a",
    "na",
    "n.a.",
    "n.a",
    "nil",
    "none",
    "null",
    "nan",
    "no data",
    "not available",
    "not applicable",
    "n/d",
    "nd",
    "s/d",
    "x",
    "z",
    "c",  # confidential, used by Eurostat and StatCan
    ".",
    "*",
    "**",
    "†",
    "‡",
}

# Characters that are visually a minus sign but are not U+002D.
_DASHES = {
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2212": "-",
}

# Spaces used as thousands separators, including the ones that are not U+0020.
_SPACES = "\u00a0\u2007\u202f\u2009\u2008\u200a\u3000"


def _clean(raw: str) -> str:
    s = raw.strip()
    for bad, good in _DASHES.items():
        s = s.replace(bad, good)
    for sp in _SPACES:
        s = s.replace(sp, " ")
    return s


def is_null_token(raw: object) -> bool:
    """Whether a cell is one of the conventional markers for absent data."""
    if raw is None:
        return True
    if isinstance(raw, float) and math.isnan(raw):
        return True
    return _clean(str(raw)).lower() in NULL_TOKENS


def decimal_convention(text: str) -> str | None:
    """
    Which character this text uses for the decimal point, where it can be told.

    Returns 'dot', 'comma', or None. The evidence is the language of any
    magnitude word, then the currency. Both are properties of the document
    rather than of the digits, which is why they can resolve a string the
    digits alone cannot.
    """
    if not text:
        return None
    if _COMMA_DECIMAL_RE.search(text):
        return "comma"
    m = _MAGNITUDE_RE.search(text)
    if m and m.group(1).lower() in DOT_DECIMAL_WORDS:
        return "dot"
    if DOT_DECIMAL_CURRENCY.search(text):
        return "dot"
    return None


def parse_number(raw: object, context: str | None = None) -> float | None:
    """
    Read a printed number, or return None having refused to guess.

    Returns None when the input is empty, is a conventional no-data marker, or
    is ambiguous in a way that would change the value by orders of magnitude.

    `context` is any surrounding text that might name the convention: a column
    header, a table caption, the sentence a figure sits in. It is only consulted
    for the genuinely ambiguous case, and only as evidence, never as a default.
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        if isinstance(raw, float) and (math.isnan(raw) or math.isinf(raw)):
            return None
        return float(raw)

    s = _clean(str(raw))
    if not s or s.lower() in NULL_TOKENS:
        return None

    # The string itself is the first place to look for the convention, since a
    # value often carries its own unit: "US$ 1,204 million".
    convention = decimal_convention(s) or decimal_convention(context or "")

    negative = False

    # Accounting notation: (1,234) means minus 1234.
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1].strip()

    if s.endswith("-"):  # trailing minus, seen in mainframe exports
        negative = True
        s = s[:-1].strip()

    multiplier = 1.0
    m = _MAGNITUDE_RE.search(s)
    if m:
        multiplier = MAGNITUDE[m.group(1).lower()]
        s = (s[: m.start()] + " " + s[m.end():]).strip()

    percent = s.endswith("%")
    if percent:
        s = s[:-1].strip()

    # Scientific notation has to be recognised before the decoration is
    # stripped, because the 'e' is part of the number rather than part of a
    # word. Keeping 'e' in the allowed set for every input was a bug: it let
    # the tail of a currency code through, so "1,204 EUR" became "1,204 E"
    # and failed to parse at all rather than reading as 1204.
    if _SCIENTIFIC_RE.fullmatch(s.replace(" ", "")):
        s = s.replace(" ", "")
    else:
        # What the currency was is a separate question answered by
        # normalize.currency; here it only needs removing.
        s = re.sub(r"[^\d,.\s\-+]", "", s).strip()
    s = re.sub(r"\s+", " ", s)

    if not s:
        return None

    if s.startswith("-"):
        negative = True
        s = s[1:].strip()
    elif s.startswith("+"):
        s = s[1:].strip()

    body = _disambiguate(s, convention)
    if body is None:
        return None

    try:
        value = float(body)
    except ValueError:
        return None

    if math.isnan(value) or math.isinf(value):
        return None

    value *= multiplier
    if percent:
        value /= 100.0
    return -value if negative else value


def _disambiguate(s: str, convention: str | None = None) -> str | None:
    """
    Work out which separator is the decimal point.

    The rules below are ordered so that every decision rests on evidence: first
    in the digits themselves, then in `convention` where the surrounding text
    named one. Where nothing separates the two readings this returns None
    rather than picking one, because picking wrong is a 1000x error that
    nothing downstream will catch.
    """
    s = s.replace(" ", "")

    if not s:
        return None

    # Scientific notation is unambiguous.
    if re.fullmatch(r"\d+(\.\d+)?[eE][+-]?\d+", s):
        return s

    has_comma = "," in s
    has_dot = "." in s

    if not has_comma and not has_dot:
        return s if s.isdigit() else None

    if has_comma and has_dot:
        # Both present: the rightmost one is the decimal separator, because a
        # thousands separator never appears after a decimal point.
        if s.rfind(",") > s.rfind("."):
            return s.replace(".", "").replace(",", ".")
        return s.replace(",", "")

    sep = "," if has_comma else "."
    parts = s.split(sep)

    if len(parts) > 2:
        # Repeated separator can only be thousands grouping: 1.234.567
        if all(len(p) == 3 for p in parts[1:]):
            return s.replace(sep, "")
        return None

    left, right = parts

    # Exactly three digits after the separator is the ambiguous case, and it is
    # common: "1,234" is 1234 in English and 1.234 in German.
    if len(right) == 3:
        if sep == "," and len(left) > 3:
            # 12345,678 cannot be thousands grouping, the left group is wrong.
            return s.replace(",", ".")
        if left == "0":
            # "0,123" is a decimal in any convention: nobody groups a zero.
            return s.replace(sep, ".")
        # The digits cannot settle it. The surrounding text sometimes can.
        if convention == "dot":
            return s.replace(",", "") if sep == "," else s
        if convention == "comma":
            return s.replace(".", "") if sep == "." else s.replace(",", ".")
        # Genuinely ambiguous with nothing to go on. Refuse.
        return None

    if len(right) in (1, 2) or len(right) >= 4:
        # Not a valid thousands group, so it is a decimal separator.
        return s.replace(sep, ".")

    return None


def parse_number_with_scale(raw: object, header_hint: str | None = None) -> tuple[float | None, str | None]:
    """
    Read a number, applying a scale stated in the column header.

    Statistical tables very often carry the magnitude once, in the header, and
    then print bare numbers: a column headed "Value (US$ million)" holding
    "1,204" means 1.204 billion dollars. Missing that understates every figure
    in the column by a million, so it has to be read from the header rather
    than from the cell.

    The header is also passed as parse context, because a header naming a
    magnitude in a particular language settles which separator the cells below
    it use.

    Returns the value and a note naming the scale that was applied, so it can
    be recorded rather than silently baked in.
    """
    value = parse_number(raw, context=header_hint)
    if value is None or not header_hint:
        return value, None

    m = _MAGNITUDE_RE.search(header_hint)
    if not m:
        return value, None

    # Only apply a header scale when the cell did not carry one itself, or the
    # multiplication happens twice.
    if _MAGNITUDE_RE.search(str(raw)):
        return value, None

    word = m.group(1).lower()
    return value * MAGNITUDE[word], f"scale-from-header:{word}"


def plausible_trade_value(value: float) -> tuple[bool, str | None]:
    """
    A coarse sanity bound on a single trade figure in dollars.

    Deliberately wide. World merchandise trade is roughly 24 trillion dollars a
    year, so anything past 100 trillion in one cell is a misread separator or a
    misapplied scale rather than a real number. Negative values are legitimate
    in balance and revision tables, so they pass here and are judged by whoever
    knows what the column means.
    """
    if value == 0:
        return True, None
    magnitude = abs(value)
    if magnitude > 1e14:
        return False, "above 100 trillion, likely a separator or scale error"
    if magnitude < 0.01:
        return False, "below one cent, likely a unit or scale error"
    return True, None
