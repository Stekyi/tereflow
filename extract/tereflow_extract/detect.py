"""
What is this thing, really.

The registry stores a `fmt` for every source, and it is not reliable enough to
route on. It records what a source *offers*, not what the URL *returns*. Of
five URLs registered as csv and checked by hand, four returned an HTML landing
page and one returned a directory listing. None returned a CSV.

That matters more than it sounds. `pandas.read_csv` will happily consume a page
of HTML and return a frame of angle brackets and menu labels, and every one of
those rows would look like data to anything downstream. The whole point of this
pipeline is that it does not invent values, so the type has to be established
from the bytes rather than taken on trust.

Detection therefore runs in three passes, cheapest first, and each pass can
overrule the one before it:

  1. the URL, which is a hint and never a conclusion
  2. the Content-Type header, which servers get wrong often enough to check
  3. the leading bytes, which are the only thing that cannot lie

Everything that contributed is recorded on the Probe, so a wrong call can be
traced to the signal that caused it.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from .contracts import Probe, SourceType

# Magic numbers. These are file format definitions, not guesses.
MAGIC: list[tuple[bytes, SourceType, str]] = [
    (b"%PDF-", SourceType.PDF_TEXT, "magic:%PDF"),
    # XLSX and ODS are both zip containers. Which one is settled after opening.
    (b"PK\x03\x04", SourceType.ZIP, "magic:zip"),
    # The old binary .xls compound document.
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", SourceType.EXCEL, "magic:ole2"),
]

_HTML_HINT = re.compile(rb"<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]", re.I)
_SDMX_HINT = re.compile(
    rb"<(?:\w+:)?(?:GenericData|StructureSpecificData|CompactData|MessageGroup)[\s>]"
    rb"|sdmx\.org/resources/sdmxml",
    re.I,
)
_XML_HINT = re.compile(rb"^\s*<\?xml[\s\S]{0,200}", re.I)

# Extensions worth believing as a first hint. Anything else falls through to
# the bytes, which is where the answer actually comes from.
EXT_HINT: dict[str, SourceType] = {
    ".csv": SourceType.CSV,
    ".tsv": SourceType.CSV,
    ".txt": SourceType.CSV,
    ".xlsx": SourceType.EXCEL,
    ".xls": SourceType.EXCEL,
    ".xlsm": SourceType.EXCEL,
    ".ods": SourceType.EXCEL,
    ".pdf": SourceType.PDF_TEXT,
    ".json": SourceType.JSON,
    ".zip": SourceType.ZIP,
    ".xml": SourceType.SDMX,
}

MIME_HINT: list[tuple[str, SourceType]] = [
    ("application/pdf", SourceType.PDF_TEXT),
    ("application/vnd.openxmlformats-officedocument.spreadsheetml", SourceType.EXCEL),
    ("application/vnd.ms-excel", SourceType.EXCEL),
    ("application/vnd.oasis.opendocument.spreadsheet", SourceType.EXCEL),
    ("application/json", SourceType.JSON),
    ("text/json", SourceType.JSON),
    ("application/vnd.sdmx", SourceType.SDMX),
    ("text/csv", SourceType.CSV),
    ("text/tab-separated-values", SourceType.CSV),
    ("application/zip", SourceType.ZIP),
    ("application/xml", SourceType.SDMX),
    ("text/xml", SourceType.SDMX),
    ("text/html", SourceType.HTML_STATIC),
    ("application/xhtml", SourceType.HTML_STATIC),
    # A file server index. Not data itself, but a page listing data files, so
    # it goes down the same discovery path as an HTML landing page rather than
    # being written off as unknown. FAOSTAT's bulk download area serves this.
    ("application/x-directory", SourceType.HTML_STATIC),
    ("text/directory", SourceType.HTML_STATIC),
]


def from_url(url: str) -> tuple[SourceType | None, str | None]:
    """A hint from the path, worth having and never worth trusting alone."""
    path = urlparse(url).path.lower()
    for ext, t in EXT_HINT.items():
        if path.endswith(ext):
            return t, f"url:ext{ext}"
    # A query string asking for a format is a stronger hint than a bare path,
    # because it is usually a deliberate export link rather than a page name.
    q = urlparse(url).query.lower()
    for token, t in (
        ("format=csv", SourceType.CSV),
        ("format=json", SourceType.JSON),
        ("format=xlsx", SourceType.EXCEL),
        ("outputformat=csv", SourceType.CSV),
        ("downloadformat=csv", SourceType.CSV),
    ):
        if token in q:
            return t, f"url:query:{token}"
    return None, None


def from_mime(content_type: str | None) -> tuple[SourceType | None, str | None]:
    if not content_type:
        return None, None
    ct = content_type.split(";")[0].strip().lower()
    for prefix, t in MIME_HINT:
        if ct.startswith(prefix):
            return t, f"mime:{ct}"
    return None, None


def from_bytes(head: bytes) -> tuple[SourceType | None, str | None]:
    """
    The only signal that cannot be wrong about what it is looking at.

    Order matters. HTML is checked before the delimiter counting that follows
    it, because a page of markup has plenty of commas and would otherwise be
    read as a CSV with very strange columns.
    """
    if not head:
        return None, None

    for sig, t, why in MAGIC:
        if head.startswith(sig):
            return t, why

    sample = head[:4096]

    if _HTML_HINT.search(sample):
        return SourceType.HTML_STATIC, "bytes:html-tag"

    if _SDMX_HINT.search(sample):
        return SourceType.SDMX, "bytes:sdmx-root"

    stripped = sample.lstrip()
    if stripped[:1] in (b"{", b"["):
        return SourceType.JSON, "bytes:json-open"

    if _XML_HINT.match(sample):
        # XML that is not SDMX is still XML, and the SDMX parser knows how to
        # say it does not recognise a message. Better than calling it unknown.
        return SourceType.SDMX, "bytes:xml-decl"

    return None, None


def looks_delimited(head: bytes, min_rows: int = 3) -> tuple[bool, str | None]:
    """
    Does this actually look like a table of delimited text.

    Requires the same delimiter to appear a consistent number of times across
    several lines. One comma on one line is prose; four commas on each of four
    lines is a table. This is what stops a text file or an error message being
    parsed as a single-column CSV of nonsense.
    """
    try:
        text = head.decode("utf-8", errors="replace")
    except Exception:
        return False, None

    lines = [ln for ln in text.splitlines() if ln.strip()][:20]
    if len(lines) < min_rows:
        return False, None

    for delim, name in ((",", "comma"), (";", "semicolon"), ("\t", "tab"), ("|", "pipe")):
        counts = [ln.count(delim) for ln in lines[:min_rows]]
        if counts[0] >= 1 and len(set(counts)) == 1:
            return True, name
    return False, None


def classify(
    url: str,
    content_type: str | None,
    head: bytes,
    declared_fmt: str | None = None,
) -> tuple[SourceType, list[str]]:
    """
    Settle the type, and record every signal that had a say.

    The bytes win. Where they are silent, the mime type decides; where that is
    silent too, the extension. `declared_fmt` from the registry is recorded for
    comparison but never gets a vote, because it has been measured to be wrong
    more often than right on this registry.
    """
    evidence: list[str] = []
    if declared_fmt:
        evidence.append(f"declared:{declared_fmt}")

    url_t, url_why = from_url(url)
    if url_why:
        evidence.append(url_why)

    mime_t, mime_why = from_mime(content_type)
    if mime_why:
        evidence.append(mime_why)

    byte_t, byte_why = from_bytes(head)
    if byte_why:
        evidence.append(byte_why)

    resolved = byte_t or mime_t or url_t

    # A server that says text/plain or nothing at all is common for CSV. If
    # the bytes are silent but the shape is a consistent grid, take it.
    if resolved in (None, SourceType.CSV) or (
        resolved is SourceType.HTML_STATIC and byte_t is None
    ):
        delimited, delim_name = looks_delimited(head)
        if delimited:
            evidence.append(f"bytes:delimited:{delim_name}")
            resolved = SourceType.CSV
        elif resolved is None:
            evidence.append("bytes:no-structure-found")

    if resolved is None:
        resolved = SourceType.UNKNOWN

    if declared_fmt and _declared_disagrees(declared_fmt, resolved):
        evidence.append(f"override:declared-{declared_fmt}-was-wrong")

    return resolved, evidence


def _declared_disagrees(declared: str, actual: SourceType) -> bool:
    """Whether the registry label and the bytes tell different stories."""
    equivalent: dict[str, set[SourceType]] = {
        "csv": {SourceType.CSV},
        "xlsx": {SourceType.EXCEL, SourceType.ZIP},
        "pdf": {SourceType.PDF_TEXT, SourceType.PDF_SCANNED},
        "json": {SourceType.JSON},
        "api": {SourceType.JSON, SourceType.SDMX, SourceType.CSV},
        "sdmx": {SourceType.SDMX},
        "html": {SourceType.HTML_STATIC, SourceType.HTML_DYNAMIC},
    }
    allowed = equivalent.get(declared.lower())
    return bool(allowed) and actual not in allowed


def refine_pdf(page_text_lengths: list[int], page_count: int) -> SourceType:
    """
    Text PDF or scanned image, decided by how much text came out.

    A born-digital PDF yields hundreds of characters a page. A scan yields
    nothing, or a scatter of noise from an embedded thumbnail. The threshold is
    per page and deliberately low: a title page with fifty characters should
    not condemn a document whose other pages are full of text.
    """
    if not page_text_lengths:
        return SourceType.PDF_SCANNED
    pages_with_text = sum(1 for n in page_text_lengths if n >= 100)
    if page_count and pages_with_text / page_count >= 0.5:
        return SourceType.PDF_TEXT
    if pages_with_text == 0:
        return SourceType.PDF_SCANNED
    # Mixed: some pages digital, some scanned. Treated as scanned so the OCR
    # path runs, because it falls back to the text layer where one exists.
    return SourceType.PDF_SCANNED


def refine_zip(names: list[str]) -> SourceType:
    """A zip is a container. What matters is what is inside it."""
    lowered = [n.lower() for n in names]
    if any(n.startswith("xl/") or n == "[content_types].xml" for n in lowered):
        if any(n.startswith("xl/") for n in lowered):
            return SourceType.EXCEL
    if any(n == "mimetype" or n.startswith("content.xml") for n in lowered):
        return SourceType.EXCEL  # OpenDocument spreadsheet
    if any(n.endswith(".csv") or n.endswith(".tsv") for n in lowered):
        return SourceType.CSV
    if any(n.endswith(".pdf") for n in lowered):
        return SourceType.PDF_TEXT
    if any(n.endswith(".xlsx") or n.endswith(".xls") for n in lowered):
        return SourceType.EXCEL
    return SourceType.UNKNOWN
