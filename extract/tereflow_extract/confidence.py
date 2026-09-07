"""
How much to trust a row, and why.

The score exists to answer one question: should this number be allowed into the
database where the app will present it to somebody as a fact. Everything about
it is therefore explainable. A row that scores badly records which component
dropped it, so the answer to "why is this missing" is always available and is
never "the model decided".

There is no learning here and no probability. Each component is a stated rule
about evidence that was or was not present, and the weights say how much each
kind of evidence matters for a trade figure. That makes the score arguable,
which is the point: a threshold that cannot be argued with cannot be tuned.

Deliberately absent: any component that rewards a value for looking plausible.
Plausibility is not evidence. A fabricated number that lands in the right range
is more dangerous than an obviously wrong one, and scoring it higher would be
exactly backwards.
"""

from __future__ import annotations

from .contracts import ConfidenceBreakdown, Extraction, SourceType, Verdict
from .normalize.numbers import plausible_trade_value

# What each part of the evidence is worth. They sum to 1.
#
# Value carries the most because a figure whose magnitude cannot be trusted is
# useless whatever else is known about it. Year is next: a correct value in the
# wrong year is worse than no value, since it will be compared against other
# years and produce a growth rate out of nothing.
WEIGHTS: dict[str, float] = {
    "value": 0.30,
    "year": 0.22,
    "country": 0.18,
    "flow": 0.14,
    "commodity": 0.10,
    "structure": 0.06,
}

# How much the way a row was obtained is worth on its own. A cell in a machine
# readable table is not the same kind of evidence as a number read off a scan.
STRUCTURE_BY_TYPE: dict[SourceType, float] = {
    SourceType.JSON: 1.0,
    SourceType.SDMX: 1.0,
    SourceType.CSV: 0.95,
    SourceType.EXCEL: 0.9,
    SourceType.HTML_STATIC: 0.75,
    SourceType.HTML_DYNAMIC: 0.7,
    SourceType.PDF_TEXT: 0.6,
    SourceType.PDF_SCANNED: 0.35,
    SourceType.ZIP: 0.5,
    SourceType.UNKNOWN: 0.2,
}

# Below this a row is not written as a fact. It is kept, with its reason, in the
# quarantine file.
ACCEPT_THRESHOLD = 0.62

# Flags that cap the score however good the rest of the evidence looks. These
# are not penalties to be outweighed; they are statements that one part of the
# row is known to be unreliable, and a high score elsewhere cannot fix it.
CAPS: dict[str, float] = {
    "ocr:low-confidence": 0.45,
    "ocr:ambiguous-digit": 0.40,
    "source:prose": 0.70,
    "header:inferred": 0.65,
    "table:continued": 0.75,
    "reshaped:wide-to-long": 0.90,
}


def score(ex: Extraction) -> Extraction:
    """
    Fill in the confidence, the breakdown and the verdict.

    Mutates and returns the same object. The breakdown notes are written for a
    person reading the quarantine file, so they say what was missing rather
    than naming an internal rule.
    """
    b = ConfidenceBreakdown()

    b.value = _value_component(ex, b)
    b.year = _year_component(ex, b)
    b.country = _country_component(ex, b)
    b.flow = _flow_component(ex, b)
    b.commodity = _commodity_component(ex, b)
    b.structure = _structure_component(ex, b)

    total = b.total(WEIGHTS)

    for flag, cap in CAPS.items():
        if flag in ex.flags and total > cap:
            total = cap
            b.notes.append(f"capped at {cap} because the row is flagged {flag}")

    ex.breakdown = b
    ex.confidence = round(total, 4)
    ex.verdict = _verdict(ex)
    return ex


def _value_component(ex: Extraction, b: ConfidenceBreakdown) -> float:
    if ex.value is None:
        b.notes.append("no value could be read from the cell")
        return 0.0

    ok, why = plausible_trade_value(ex.value)
    if not ok:
        b.notes.append(f"value rejected: {why}")
        return 0.0

    if ex.currency is None:
        # The number was read but its unit is unknown, which is not the same as
        # the number being wrong. It scores, but it cannot become a USD fact.
        b.notes.append("value read but the currency was not stated anywhere")
        return 0.55

    if ex.currency == "USD":
        return 1.0

    b.notes.append(f"value is in {ex.currency}, not USD")
    return 0.85


def _year_component(ex: Extraction, b: ConfidenceBreakdown) -> float:
    if ex.year is None:
        b.notes.append("no year found for this row")
        return 0.0
    if ex.year < 1960 or ex.year > 2100:
        b.notes.append(f"year {ex.year} is outside the range these sources cover")
        return 0.0
    if ex.period:
        # A quarter or a month is a real period and a precise one, but a caller
        # summing them into a year needs to know they are not annual.
        return 0.9
    return 1.0


def _country_component(ex: Extraction, b: ConfidenceBreakdown) -> float:
    """
    A row needs to be attributable to somebody.

    The reporter matters more than the partner: a figure with no reporter is
    not attached to any country at all, while a figure with no partner is a
    perfectly normal country total.
    """
    if ex.reporter_iso3:
        base = 1.0
    elif ex.reporter_name:
        b.notes.append(f"reporter {ex.reporter_name!r} could not be resolved to a country code")
        base = 0.4
    else:
        b.notes.append("no reporting country on this row")
        return 0.0

    if ex.partner_name and not ex.partner_iso3:
        # Not a fault. World totals and aggregates legitimately have no code.
        b.notes.append(f"partner {ex.partner_name!r} has no country code, may be an aggregate")
        base = min(base, 0.85)

    return base


def _flow_component(ex: Extraction, b: ConfidenceBreakdown) -> float:
    if ex.flow in ("export", "import"):
        return 1.0
    b.notes.append("could not tell whether this row is an export or an import")
    return 0.0


def _commodity_component(ex: Extraction, b: ConfidenceBreakdown) -> float:
    """
    What was traded, which is allowed to be absent.

    A country total carries no product and is still a complete and useful fact,
    so the absence of a commodity is not treated as a failure. It scores lower
    than a coded line because it says less, not because it is less true.
    """
    if ex.hs_code and ex.product_name:
        return 1.0
    if ex.hs_code:
        return 0.9
    if ex.product_name:
        b.notes.append("product named but no HS code, so it cannot be matched across sources")
        return 0.6
    if ex.sector:
        return 0.5
    return 0.45


def _structure_component(ex: Extraction, b: ConfidenceBreakdown) -> float:
    if ex.provenance is None:
        b.notes.append("no provenance recorded, so this row cannot be checked against its source")
        return 0.0
    base = STRUCTURE_BY_TYPE.get(ex.provenance.source_type, 0.3)
    if ex.provenance.raw_value is None:
        b.notes.append("the original cell text was not kept")
        base = min(base, 0.6)
    return base


def _verdict(ex: Extraction) -> Verdict:
    """
    The single reason this row did or did not become a fact.

    Ordered so the most fundamental problem is the one reported. Somebody
    reading the quarantine file wants the thing to fix, and being told a row is
    low confidence when the real problem is that it has no year is not useful.
    """
    if ex.value is None:
        return Verdict.UNPARSEABLE_VALUE
    if ex.year is None:
        return Verdict.NO_YEAR
    if ex.flow is None:
        return Verdict.MISSING_REQUIRED
    if ex.reporter_iso3 is None:
        return Verdict.AMBIGUOUS_COUNTRY

    ok, _ = plausible_trade_value(ex.value)
    if not ok:
        return Verdict.IMPLAUSIBLE

    # Currency is checked before the threshold so a perfectly good row in cedis
    # is reported as non-USD rather than as low quality. It is neither.
    if ex.value_usd is None:
        return Verdict.NON_USD if ex.currency else Verdict.UNKNOWN_CURRENCY

    if ex.confidence < ACCEPT_THRESHOLD:
        return Verdict.LOW_CONFIDENCE

    return Verdict.ACCEPTED


def explain(ex: Extraction) -> str:
    """One line a person can read, for logs and the quarantine file."""
    parts = [f"{ex.confidence:.2f}"]
    if ex.verdict:
        parts.append(ex.verdict.value)
    if ex.breakdown.notes:
        parts.append("; ".join(ex.breakdown.notes[:3]))
    return " | ".join(parts)
