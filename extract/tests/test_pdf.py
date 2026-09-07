"""
Proof that the PDF parsers do what they claim on real bytes.

Every fixture here is a genuine PDF built at test time, not a mock: reportlab
lays down a ruled table and a page of prose, pypdf encrypts one, and Pillow
writes an image-only page with no text layer. The real UNCTAD Handbook of
Statistics PDF is used too when it is present in tests/fixtures, because a
document nobody controls is the honest test.

The four assertions the task names each have a test: a text PDF yields tables,
page_text_lengths separates text from scanned, an encrypted PDF is flagged and
not crashed, and ocr_available reports Tesseract missing on this machine. The
OCR extraction path itself cannot be exercised here because the binary is
absent; that is asserted as the degrade-honestly behaviour instead.
"""

from __future__ import annotations

import io
import logging
import os

import pytest

from tereflow_extract import detect
from tereflow_extract.contracts import SourceType
from tereflow_extract.parsers.pdf_tables import parse_pdf_tables
from tereflow_extract.parsers.pdf_text import parse_pdf_text, page_text_lengths
from tereflow_extract.parsers.pdf_ocr import ocr_available, parse_pdf_scanned

# pdfminer narrates colour-space quirks at warning level on many real PDFs.
# They are harmless and would only bury the test output.
logging.getLogger("pdfminer").setLevel(logging.ERROR)

_HERE = os.path.dirname(__file__)
_REAL_PDF = os.path.join(_HERE, "fixtures", "real_tdstat49_en.pdf")


def _ruled_table_pdf() -> bytes:
    """A born-digital PDF with one grid-ruled trade table and a heading."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
    from reportlab.lib.styles import getSampleStyleSheet

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4)
    styles = getSampleStyleSheet()
    story = [Paragraph("Ghana merchandise exports by year, US$ million", styles["Title"])]

    rows = [
        ["Partner", "Flow", "2021", "2022", "2023"],
        ["Netherlands", "Exports", "1204.5", "1310.2", "1425.0"],
        ["Switzerland", "Exports", "980.1", "1102.4", "1250.9"],
        ["India", "Exports", "640.0", "705.7", "812.3"],
    ]
    table = Table(rows)
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.75, colors.black),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
            ]
        )
    )
    story.append(table)
    doc.build(story)
    return buf.getvalue()


def _prose_pdf() -> bytes:
    """A born-digital PDF whose trade figures live in sentences."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    text = c.beginText(72, 780)
    for line in [
        "Trade Bulletin, Fourth Quarter",
        "Total exports rose to US$ 3.42 billion in 2024, a record for the series.",
        "Imports of machinery reached US$ 1,204 million over the same period.",
        "The trade surplus widened by 12 per cent year on year.",
        "Chapter 3 discusses cocoa in detail on page 41.",
    ]:
        text.textLine(line)
    c.drawText(text)
    c.showPage()
    c.save()
    return buf.getvalue()


def _encrypted_pdf() -> bytes:
    """A real PDF sealed with a password pypdf cannot open empty."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(_prose_pdf()))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt("s3cret")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _image_only_pdf() -> bytes:
    """
    A PDF that is a picture of text, with no text layer at all.

    This is the shape a scan takes: page_text_lengths should read close to
    nothing from it, which is exactly what tells the detector to route it to OCR.
    """
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    draw.text((80, 120), "Exports 2023 US$ 654 billion", fill="black")
    draw.text((80, 200), "This page carries no selectable text.", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PDF", resolution=150.0)
    return buf.getvalue()


@pytest.fixture(scope="module")
def ruled_pdf() -> bytes:
    return _ruled_table_pdf()


@pytest.fixture(scope="module")
def prose_pdf() -> bytes:
    return _prose_pdf()


@pytest.fixture(scope="module")
def encrypted_pdf() -> bytes:
    return _encrypted_pdf()


@pytest.fixture(scope="module")
def image_pdf() -> bytes:
    return _image_only_pdf()


# 1. A text PDF yields tables.
def test_text_pdf_yields_tables(ruled_pdf):
    exts = parse_pdf_tables(ruled_pdf, "mem://ruled.pdf")
    data = [e for e in exts if e.value is not None]
    assert data, "a ruled trade table should yield at least one value"

    # The header row, not the spanning title, must have been the one used: a
    # partner name and a year come through, and the currency is not assumed.
    assert any(e.partner_name for e in data)
    assert any(e.year in (2021, 2022, 2023) for e in data)

    first = data[0]
    assert first.provenance.page == 1
    assert first.provenance.table_index is not None
    assert first.provenance.row_index is not None
    assert first.provenance.raw_value
    # Rule two: value_usd only exists once the currency is established as USD.
    for e in data:
        if e.currency == "USD":
            assert e.value_usd is not None and e.usd_basis == "reported"
        else:
            assert e.value_usd is None


# 2. page_text_lengths distinguishes a text PDF from a scanned one.
def test_page_text_lengths_separates_text_from_scan(prose_pdf, image_pdf):
    text_lens, text_pages = page_text_lengths(prose_pdf)
    assert text_pages == 1
    assert max(text_lens) >= 100
    assert detect.refine_pdf(text_lens, text_pages) == SourceType.PDF_TEXT

    scan_lens, scan_pages = page_text_lengths(image_pdf)
    assert scan_pages == 1
    # An image-only page has no text layer to read.
    assert max(scan_lens) < 100
    assert detect.refine_pdf(scan_lens, scan_pages) == SourceType.PDF_SCANNED


# 3. An encrypted PDF is flagged, never crashed.
def test_encrypted_pdf_is_flagged_not_crashed(encrypted_pdf):
    for parse in (parse_pdf_tables, parse_pdf_text):
        exts = parse(encrypted_pdf, "mem://locked.pdf")
        assert len(exts) == 1
        e = exts[0]
        assert "pdf:encrypted" in e.flags
        # A sentinel carries no data that could be mistaken for a real reading.
        assert e.value is None
        assert e.year is None


# 4. ocr_available reports Tesseract missing on this machine.
def test_ocr_available_reports_tesseract_missing():
    available, reason = ocr_available()
    assert available is False
    assert "Tesseract" in reason
    # The reason has to be actionable: it names the Windows install command.
    assert "winget" in reason or "choco" in reason


def test_scanned_parser_degrades_without_raising(image_pdf):
    # With OCR absent this must be an empty list and a logged warning, not an
    # exception and not a sentinel that reads as real emptiness.
    out = parse_pdf_scanned(image_pdf, "mem://scan.pdf")
    assert out == []


def test_prose_parser_reads_magnitude_and_currency(prose_pdf):
    exts = parse_pdf_text(prose_pdf, "mem://bulletin.pdf")
    assert exts, "prose with a year and a flow should yield at least one fact"
    assert all("source:prose" in e.flags for e in exts)

    billion = [e for e in exts if e.value == pytest.approx(3.42e9)]
    assert billion, "US$ 3.42 billion in 2024 should scale to 3.42e9"
    fact = billion[0]
    assert fact.year == 2024
    assert fact.currency == "USD"
    assert fact.value_usd == pytest.approx(3.42e9)
    assert fact.usd_basis == "reported"
    assert "US$ 3.42 billion" in fact.provenance.raw_value

    # The 12 per cent growth line is a rate, not a value, and must be absent.
    assert not any(e.value == 12 for e in exts)


@pytest.mark.skipif(not os.path.exists(_REAL_PDF), reason="real UNCTAD PDF not present")
def test_real_unctad_pdf_classifies_as_text():
    data = open(_REAL_PDF, "rb").read()
    lens, pages = page_text_lengths(data)
    assert pages > 1
    assert detect.refine_pdf(lens, pages) == SourceType.PDF_TEXT


@pytest.mark.skipif(not os.path.exists(_REAL_PDF), reason="real UNCTAD PDF not present")
def test_real_unctad_prose_is_cautious():
    data = open(_REAL_PDF, "rb").read()
    exts = parse_pdf_text(data, "https://unctad.org/tdstat49", max_pages=40)
    assert all("source:prose" in e.flags for e in exts)
    # A year is never the value it dates.
    assert not any(e.year is not None and e.value == e.year for e in exts)
    # Currency is stated, never assumed: nothing carries a country-name code.
    assert all(e.currency in (None, "USD") for e in exts)
