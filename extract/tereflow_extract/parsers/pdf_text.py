"""
Narrative and label-value extraction from born-digital PDFs.

Not every trade figure lives in a table. Bulletins state them in prose ("Total
exports rose to US$ 3.42 billion in 2024") and in dotted label-value lines
("Cocoa beans .......... 1,204.5"). This module reads those, and it is
deliberately timid: a bare number in a sentence is not a fact, and treating it
as one is how a pipeline that promises never to invent values ends up doing
exactly that.

The rule is a single number is only extracted when its line also carries at
least one of a year, a commodity, or a trade flow. Everything else is left
alone. It is better to return five figures that are certainly facts than fifty
that a human then has to check.

page_text_lengths exists to feed detect.refine_pdf, which tells a text PDF from
a scan by how much text each page yields, so it stays cheap.
"""

from __future__ import annotations

import io
import re

import pdfplumber

from ..contracts import Extraction, Provenance, SourceType
from ..normalize.numbers import parse_number
from ..normalize.currency import detect_currency
from ..normalize.commodities import parse_hs
from ..normalize.fields import detect_flow, parse_year

_EXTRACTOR = "pdf_text"

# A number with grouped thousands or a plain decimal. Kept strict so it does
# not swallow dates, footnote markers, or HS codes.
_NUMBER = re.compile(
    r"(?<![\w.])"
    r"(?P<num>\d{1,3}(?:[,\u00a0 ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"(?![\w])"
)

# Magnitude words. billion is 1e9. lakh and crore are included because they are
# unambiguous where they appear; nothing here guesses at them elsewhere.
_MAGNITUDES: list[tuple[re.Pattern[str], float, str]] = [
    (re.compile(r"^trillion|^tn\b", re.I), 1e12, "trillion"),
    (re.compile(r"^billion|^bn\b", re.I), 1e9, "billion"),
    (re.compile(r"^million|^mn\b", re.I), 1e6, "million"),
    (re.compile(r"^thousand", re.I), 1e3, "thousand"),
    (re.compile(r"^crore", re.I), 1e7, "crore"),
    (re.compile(r"^lakh", re.I), 1e5, "lakh"),
]

# A number immediately trailed by a percent sign or "per cent" is a rate, a
# share, or a growth figure, never a traded value or quantity.
_PERCENT_TAIL = re.compile(r"^\s*(%|per\s*cent|percent)", re.I)

_CURRENCY_ADJ = re.compile(r"(US\$|GH[¢c₵]|[$£€¥₵])\s*$")

# An explicit currency cue: a distinctive symbol or a written code. A lone "$"
# is deliberately excluded, because rule two forbids assuming which dollar a
# bare "$" means. This gates trust in detect_currency: the delivered version
# maps country names to codes, so a figure is only given a currency when the
# text beside it actually names one.
_CURRENCY_CUE = re.compile(
    r"US\$|R\$|GH[¢c₵]|[£€¥₵¢₹]"
    r"|\b(USD|EUR|GBP|JPY|CNY|RMB|INR|ZAR|NGN|GHS|XOF|XAF|CFA|CAD|AUD)\b",
    re.I,
)

# A four-digit token in the calendar range. Used to keep a bare year from being
# read as the figure the sentence reports: "Handbook of Statistics 2024" states
# no value, and 2024 is the date, not a measure.
_YEAR_TOKEN = re.compile(r"^\d{4}$")


def _is_bare_year(token: str) -> bool:
    if not _YEAR_TOKEN.match(token):
        return False
    return 1900 <= int(token) <= 2100


def page_text_lengths(data: bytes) -> tuple[list[int], int]:
    """
    Characters of extracted text per page, and the page count.

    Deliberately light: extract_text on each page and measure it, nothing more.
    An encrypted or unreadable file yields no lengths, which refine_pdf reads as
    a scan and routes to OCR, the safe direction.
    """
    lengths: list[int] = []
    try:
        with pdfplumber.open(io.BytesIO(data), password="") as pdf:
            count = len(pdf.pages)
            for page in pdf.pages:
                text = page.extract_text() or ""
                lengths.append(len(text.strip()))
        return lengths, count
    except Exception:
        return [], 0


def parse_pdf_text(data: bytes, url: str, *, max_pages: int = 60) -> list[Extraction]:
    """Extract trade figures stated in prose or in label-value lines."""
    guard = _guard(data, url)
    if guard is not None:
        return guard

    out: list[Extraction] = []
    truncated = False
    try:
        with pdfplumber.open(io.BytesIO(data), password="") as pdf:
            pages = pdf.pages
            if len(pages) > max_pages:
                truncated = True
                pages = pages[:max_pages]
            for page in pages:
                page_no = page.page_number
                text = page.extract_text() or ""
                for line in text.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    fact = _extract_line_facts(line)
                    if fact is None:
                        continue
                    out.append(_to_extraction(fact, url, page_no, line))
    except Exception:
        return _sentinel(url, "pdf:corrupt")

    if truncated:
        for e in out:
            e.flags.append(f"pages:truncated:max_pages={max_pages}")
    return out


def _extract_line_facts(line: str) -> dict | None:
    """
    Read at most one fact from a line, or return None.

    Shared with the OCR parser so prose reads the same whether the text came
    from the PDF layer or from Tesseract. Returns the components of a fact and
    the character span of the value, which the OCR caller uses to attach the
    confidence of exactly the words that formed the number.
    """
    matches = list(_NUMBER.finditer(line))
    if not matches:
        return None

    year, _ = parse_year(line)
    flow, _ = detect_flow(line)

    best = _choose_number(line, matches)
    if best is None:
        return None
    m, mult, scale_label = best

    raw_token = m.group("num")
    value = parse_number(raw_token)
    if value is None:
        return None
    value *= mult

    # The text left of the number is the label in a "name .... number" line.
    label = line[: m.start()].strip(" .\t\u2026")
    # HS is trusted only from the label, never from a scan of the whole line: a
    # whole-line scan matches page numbers in a table of contents and digit runs
    # inside identifiers. Even within the label, only a heading-length code (4+
    # digits) is trusted, because a two-digit run in running prose collides with
    # chapter numbers and stray "N per cent" figures from an adjacent column.
    hs_code = parse_hs(label)[0] if label else None
    if hs_code is not None and len(hs_code) < 4:
        hs_code = None
    product_name = label if (label and hs_code and len(label) <= 60) else None

    # The non-negotiable gate: a value is only a fact with a year, a commodity,
    # or a flow beside it.
    if year is None and flow is None and hs_code is None:
        return None

    # Currency is read from a short window immediately left of the number, where
    # a symbol or code sits ("US$ 3.42", "GH\u00a2 500", "$654"). Reading to the
    # right instead lets a trailing country name ("$448 billion Taiwan ...") pick
    # the currency, and the delivered detect_currency maps place names to codes.
    # The result is trusted only when that window carries an explicit currency
    # cue, so a bare "$" yields None: the document has not said which dollar.
    lo = max(0, m.start("num") - 12)
    win = line[lo:m.start("num")]
    cur, _ = detect_currency(win)
    if cur is not None and not _CURRENCY_CUE.search(win):
        cur = None

    return {
        "value": value,
        "currency": cur,
        "year": year,
        "flow": flow,
        "hs_code": hs_code,
        "product_name": product_name,
        "raw_label": label or None,
        "scale": scale_label,
        "value_span": (m.start("num"), m.end("num")),
    }


def _is_measure_like(token: str, has_currency: bool, has_magnitude: bool) -> bool:
    """
    Whether a number reads like a reported statistic rather than a plain integer.

    A figure a bulletin states carries a currency, a magnitude word, a decimal,
    or grouped thousands. A bare separator-less integer (a page number, a chapter
    index, part of an identifier) does not, and treating one as a value is how a
    cautious parser stops being cautious.
    """
    if has_currency or has_magnitude:
        return True
    return any(sep in token for sep in (".", ",", "\u00a0", " "))


def _choose_number(
    line: str, matches: list[re.Match[str]]
) -> tuple[re.Match[str], float, str | None] | None:
    """
    Pick the one number that is the measured value, or give up.

    A number wearing a currency symbol or a magnitude word is the figure the
    sentence is about. When several bare numbers compete and none stands out,
    the line is too ambiguous to trust and yields nothing.
    """
    scored: list[tuple[int, re.Match[str], float, str | None]] = []
    for m in matches:
        tail = line[m.end("num"): m.end("num") + 16].lstrip()
        # A figure trailed by a percent marker is a rate, not a value or quantity.
        if _PERCENT_TAIL.match(line[m.end("num"): m.end("num") + 12]):
            continue
        mult, scale_label = 1.0, None
        for pat, factor, name in _MAGNITUDES:
            if pat.match(tail):
                mult, scale_label = factor, name
                break
        has_currency = bool(_CURRENCY_ADJ.search(line[: m.start("num")]))
        token = m.group("num")
        # A bare year carrying no currency and no magnitude word is a date, not
        # the measured figure. Dropping it here is what stops a title line whose
        # only number is a year from being recorded as a value.
        if _is_bare_year(token) and scale_label is None and not has_currency:
            continue
        # An ordinary space between digit groups is trusted as a thousands
        # separator only in a monetary or magnitude context. Without that signal
        # a run like "0 25 50 75 100" is chart axis ticks, and gluing "75 100"
        # into 75100 manufactures a number nobody wrote.
        if " " in token and not has_currency and scale_label is None:
            continue
        # And a plain integer with no currency, magnitude, or separators is not a
        # reported statistic, so it never becomes a value.
        if not _is_measure_like(token, has_currency, scale_label is not None):
            continue
        score = (2 if scale_label else 0) + (1 if has_currency else 0)
        scored.append((score, m, mult, scale_label))

    if not scored:
        return None

    scored.sort(key=lambda s: s[0], reverse=True)
    top = scored[0]
    if top[0] > 0:
        # A single clear winner only.
        if len(scored) > 1 and scored[1][0] == top[0]:
            return None
        return top[1], top[2], top[3]
    if len(scored) == 1:
        return scored[0][1], scored[0][2], scored[0][3]
    return None


def _to_extraction(fact: dict, url: str, page_no: int, line: str) -> Extraction:
    ext = Extraction(
        flow=fact["flow"],
        hs_code=fact["hs_code"],
        product_name=fact["product_name"],
        value=fact["value"],
        currency=fact["currency"],
        year=fact["year"],
        provenance=Provenance(
            source_url=url,
            source_type=SourceType.PDF_TEXT,
            extractor=_EXTRACTOR,
            page=page_no,
            raw_value=line,
            raw_label=fact["raw_label"],
        ),
        flags=["source:prose"],
    )
    if fact["currency"] == "USD":
        ext.value_usd = fact["value"]
        ext.usd_basis = "reported"
    if fact["scale"]:
        ext.flags.append(f"scale:{fact['scale']}")
    return ext


def _guard(data: bytes, url: str) -> list[Extraction] | None:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception:
        return _sentinel(url, "pdf:corrupt")
    if reader.is_encrypted:
        try:
            if not reader.decrypt(""):
                return _sentinel(url, "pdf:encrypted")
        except Exception:
            return _sentinel(url, "pdf:encrypted")
    return None


def _sentinel(url: str, flag: str) -> list[Extraction]:
    return [
        Extraction(
            flags=[flag],
            provenance=Provenance(
                source_url=url,
                source_type=SourceType.PDF_TEXT,
                extractor=_EXTRACTOR,
            ),
        )
    ]
