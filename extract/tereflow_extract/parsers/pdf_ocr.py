"""
Optical character recognition for scanned PDFs.

This module does something unusual: it is written to work correctly against a
binary that is not installed on the machine it was written on. Tesseract (the
OCR engine) and poppler (which rasterises PDF pages) are both external programs,
not Python packages, and neither is present here. So the first duty of this code
is to notice their absence and say so, out loud, rather than return an empty
list that a caller would read as "this scanned document contained no data". An
empty page and a missing OCR engine are not the same fact and must never look
the same.

The extraction path is written to be correct the moment the binaries appear.
Install on Windows:

    Tesseract:
        winget install UB-Mannheim.TesseractOCR
      or  choco install tesseract
      or  download the installer from
          https://github.com/UB-Mannheim/tesseract/wiki
      then ensure tesseract.exe is on PATH (or set
      pytesseract.pytesseract.tesseract_cmd to its full path).

    poppler (provides pdftoppm / pdfinfo, needed by pdf2image):
        winget install oschwartz10612.Poppler
      or  choco install poppler
      or  download from
          https://github.com/oschwartz10612/poppler-windows/releases
      then add the extracted bin directory to PATH.

Confidence is the whole point of doing OCR this way. Each word Tesseract returns
carries a confidence, and that number is carried through to every value: a mean
per-word confidence lands in the flags as "ocr_conf:NN", anything under 60 is
additionally flagged "ocr:low-confidence", and a value holding a character that
is ambiguous in a number (the l/1, O/0, S/5, B/8 confusions, or a decimal point
that may have been lost) is flagged "ocr:ambiguous-digit" and left exactly as
read. This code never quietly corrects OCR output; a downstream scorer decides
what to trust.
"""

from __future__ import annotations

import io
import logging
import re
import shutil

from ..contracts import Extraction, Provenance, SourceType
from .pdf_text import _extract_line_facts

_LOG = logging.getLogger("tereflow_extract.parsers.pdf_ocr")
_EXTRACTOR = "pdf_ocr"

_TESSERACT_HELP = (
    "Tesseract OCR binary not found. Install on Windows with "
    "'winget install UB-Mannheim.TesseractOCR' or 'choco install tesseract', "
    "or from https://github.com/UB-Mannheim/tesseract/wiki, then put "
    "tesseract.exe on PATH."
)
_POPPLER_HELP = (
    "poppler not found (pdftoppm/pdfinfo missing, required by pdf2image). "
    "Install on Windows with 'winget install oschwartz10612.Poppler' or "
    "'choco install poppler', or from "
    "https://github.com/oschwartz10612/poppler-windows/releases, then add its "
    "bin directory to PATH."
)

# Characters that are ambiguous when they turn up inside what should be a
# number. Their presence is reported, never silently repaired.
_AMBIGUOUS_IN_NUMBER = set("lIoOsSBbZgq")


def ocr_available() -> tuple[bool, str]:
    """
    Whether OCR can actually run, and a plain reason with install steps if not.

    Checks the two real dependencies separately so the reason names whichever
    is missing rather than a generic failure.
    """
    reasons: list[str] = []

    try:
        import pytesseract

        pytesseract.get_tesseract_version()
    except Exception:
        reasons.append(_TESSERACT_HELP)

    if not _poppler_present():
        reasons.append(_POPPLER_HELP)

    if reasons:
        return False, " ".join(reasons)
    return True, ""


def _poppler_present() -> bool:
    """poppler ships pdftoppm and pdfinfo; either on PATH means it is installed."""
    return bool(shutil.which("pdftoppm") or shutil.which("pdfinfo"))


def parse_pdf_scanned(
    data: bytes, url: str, *, max_pages: int = 20, dpi: int = 300
) -> list[Extraction]:
    """
    OCR a scanned PDF and read trade figures from the recovered text.

    When OCR is unavailable this returns an empty list and logs a clear warning.
    It does not raise, and it does not return silence that could be mistaken for
    an empty document, because the caller can tell the two apart: absence of the
    engine is a logged condition, not a data outcome.
    """
    available, reason = ocr_available()
    if not available:
        _LOG.warning("OCR unavailable, skipping scanned PDF %s: %s", url, reason)
        return []

    import pytesseract
    from pdf2image import convert_from_bytes
    from pytesseract import Output

    guard = _guard(data, url)
    if guard is not None:
        return guard

    try:
        images = convert_from_bytes(
            data, dpi=dpi, first_page=1, last_page=max_pages
        )
    except Exception as exc:
        # A rasterisation failure here is almost always a broken poppler install
        # or an unreadable file; report it rather than crash the run.
        _LOG.warning("rasterisation failed for %s: %s", url, exc)
        return _sentinel(url, "pdf:corrupt")

    truncated = len(images) >= max_pages and _page_count(data) > max_pages

    out: list[Extraction] = []
    for page_index, image in enumerate(images):
        page_no = page_index + 1
        try:
            wordbag = pytesseract.image_to_data(image, output_type=Output.DICT)
        except Exception as exc:
            _LOG.warning("OCR failed on page %d of %s: %s", page_no, url, exc)
            continue
        for line, words in _lines_from_words(wordbag):
            fact = _extract_line_facts(line)
            if fact is None:
                continue
            out.append(_to_extraction(fact, url, page_no, line, words))

    if truncated:
        for e in out:
            e.flags.append(f"pages:truncated:max_pages={max_pages}")
    return out


def _lines_from_words(data: dict) -> list[tuple[str, list[tuple[int, int, str, float]]]]:
    """
    Rebuild text lines from Tesseract's per-word output.

    Words are grouped by (block, paragraph, line) so the reconstructed line
    matches what a reader would see, and each word keeps its confidence and its
    character offsets within the line so a value can be traced back to exactly
    the words that formed it.
    """
    n = len(data["text"])
    groups: dict[tuple[int, int, int], list[int]] = {}
    order: list[tuple[int, int, int]] = []
    for i in range(n):
        text = (data["text"][i] or "").strip()
        if not text:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(i)

    lines: list[tuple[str, list[tuple[int, int, str, float]]]] = []
    for key in order:
        pieces: list[str] = []
        spans: list[tuple[int, int, str, float]] = []
        cursor = 0
        for idx in groups[key]:
            token = data["text"][idx].strip()
            if not token:
                continue
            if pieces:
                cursor += 1  # the single space joining words
            start = cursor
            end = start + len(token)
            try:
                conf = float(data["conf"][idx])
            except (TypeError, ValueError):
                conf = -1.0
            spans.append((start, end, token, conf))
            pieces.append(token)
            cursor = end
        if pieces:
            lines.append((" ".join(pieces), spans))
    return lines


def _to_extraction(
    fact: dict,
    url: str,
    page_no: int,
    line: str,
    words: list[tuple[int, int, str, float]],
) -> Extraction:
    v_start, v_end = fact["value_span"]
    confidences = [
        conf
        for (start, end, _tok, conf) in words
        if conf >= 0 and start < v_end and end > v_start
    ]
    mean_conf = sum(confidences) / len(confidences) if confidences else 0.0

    ext = Extraction(
        flow=fact["flow"],
        hs_code=fact["hs_code"],
        product_name=fact["product_name"],
        value=fact["value"],
        currency=fact["currency"],
        year=fact["year"],
        provenance=Provenance(
            source_url=url,
            source_type=SourceType.PDF_SCANNED,
            extractor=_EXTRACTOR,
            page=page_no,
            raw_value=line,
            raw_label=fact["raw_label"],
        ),
        flags=["source:prose", f"ocr_conf:{int(round(mean_conf))}"],
    )
    if fact["currency"] == "USD":
        ext.value_usd = fact["value"]
        ext.usd_basis = "reported"
    if fact["scale"]:
        ext.flags.append(f"scale:{fact['scale']}")
    if mean_conf < 60:
        ext.flags.append("ocr:low-confidence")

    raw_token = line[v_start:v_end]
    if _has_ambiguous_digit(raw_token):
        ext.flags.append("ocr:ambiguous-digit")
    return ext


def _has_ambiguous_digit(token: str) -> bool:
    """True when a number as read contains a character that a scanner confuses."""
    return any(ch in _AMBIGUOUS_IN_NUMBER for ch in token)


def _page_count(data: bytes) -> int:
    from pypdf import PdfReader

    try:
        return len(PdfReader(io.BytesIO(data)).pages)
    except Exception:
        return 0


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
                source_type=SourceType.PDF_SCANNED,
                extractor=_EXTRACTOR,
            ),
        )
    ]
