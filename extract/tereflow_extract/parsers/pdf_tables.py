"""
Table extraction from born-digital PDFs.

Statistical PDFs split roughly evenly between two shapes: tables drawn with
ruling lines, and tables held together only by whitespace alignment. pdfplumber
reads the first well with its default line strategy and misses the second
entirely, so any page that yields nothing from lines is retried with the
text-positional strategy before it is given up on.

The hard part of a PDF table is not the cells, it is the header. A spreadsheet
reader is handed a header; here the header has to be found. The first row is
usually a title spanning the whole table, real column labels sit one or two
rows down, and a wide table often stacks a group label ("Exports") over a row
of sub labels ("2021 | 2022 | 2023"). We locate the header by scoring rows on
how many of their cells resolve to a known field role, try a two-row
combination where the single best row is weak, and inherit a spanning group
label leftward into the empty cells beneath it.

Nothing here decides what a number means on its own. Column roles come from
map_header, currencies from detect_currency, and a value only ever becomes USD
when the document says so. A page with no tables returns an empty list, which
is a normal outcome and not an error.
"""

from __future__ import annotations

import io
import re

import pdfplumber

from ..contracts import Extraction, Provenance, SourceType
from ..normalize.numbers import parse_number
from ..normalize.currency import detect_currency
from ..normalize.countries import resolve_country
from ..normalize.commodities import parse_hs
from ..normalize.fields import map_header, detect_flow, parse_year

_EXTRACTOR = "pdf_tables"

# Roles that describe a row rather than carry a measured number.
_DIMENSION_ROLES = {
    "reporter",
    "partner",
    "product",
    "hs_code",
    "flow",
    "currency",
    "year",
    "qty_unit",
    "sector",
}

# Scale qualifiers that appear in headers and titles. A value printed under
# "US$ '000" is a thousand times what the cell says, and refusing to apply that
# would silently understate every figure in the column. billion is 1e9.
_SCALE_PATTERNS: list[tuple[re.Pattern[str], float, str]] = [
    (re.compile(r"\bbillion\b|\bbn\b", re.I), 1e9, "billion"),
    (re.compile(r"\bmillion\b|\bmn\b", re.I), 1e6, "million"),
    (re.compile(r"\bthousand\b|'000\b|’000\b", re.I), 1e3, "thousand"),
    (re.compile(r"\bcrore\b", re.I), 1e7, "crore"),
    (re.compile(r"\blakh\b", re.I), 1e5, "lakh"),
]


def parse_pdf_tables(data: bytes, url: str, *, max_pages: int = 60) -> list[Extraction]:
    """Extract trade observations from every table in a born-digital PDF."""
    guard = _guard_open(data, url)
    if guard is not None:
        return guard

    out: list[Extraction] = []
    # Carried between pages so a table split across a page break keeps its
    # header instead of being read as an unlabelled grid.
    last_headers: list[str] | None = None
    last_colcount: int | None = None
    truncated = False

    try:
        with pdfplumber.open(io.BytesIO(data), password="") as pdf:
            pages = pdf.pages
            if len(pages) > max_pages:
                truncated = True
                pages = pages[:max_pages]

            for page in pages:
                page_no = page.page_number  # pdfplumber is already 1-based here
                tables = _tables_on_page(page)
                for t_idx, table in enumerate(tables):
                    rows = _clean_table(table)
                    if not rows:
                        continue

                    header_info = _find_header(rows)
                    if header_info is None:
                        # No header of its own. If it lines up with the table we
                        # just read, it is almost certainly a continuation.
                        if (
                            last_headers is not None
                            and last_colcount == _width(rows)
                        ):
                            headers = last_headers
                            data_rows = rows
                            continued = True
                            multi = False
                            data_start = 0
                        else:
                            continue
                    else:
                        headers, data_start, multi = header_info
                        data_rows = rows[data_start:]
                        continued = False
                        last_headers = headers
                        last_colcount = _width(rows)

                    title = _title_text(rows, 0 if continued else data_start)
                    exts = _rows_to_extractions(
                        headers=headers,
                        data_rows=data_rows,
                        data_start_abs=(0 if continued else data_start),
                        title=title,
                        url=url,
                        page_no=page_no,
                        table_index=t_idx,
                    )
                    if multi:
                        _add_flag(exts, "header:multi-row")
                    if continued:
                        _add_flag(exts, "table:continued")
                    out.extend(exts)
    except Exception:
        # Anything pdfplumber throws mid-document (a malformed object stream,
        # a truncated file) is reported, never propagated.
        return _sentinel(url, "pdf:corrupt")

    if truncated:
        _add_flag(out, f"pages:truncated:max_pages={max_pages}")
    return out


def _tables_on_page(page) -> list[list[list[str | None]]]:
    """Lines first, then a whitespace retry for the pages that came back empty."""
    tables = page.extract_tables() or []
    if tables:
        return tables
    text_settings = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
    }
    return page.extract_tables(text_settings) or []


def _clean_table(table: list[list[str | None]]) -> list[list[str]]:
    """Normalise cells and drop rows and columns that are entirely empty."""
    rows: list[list[str]] = []
    for raw in table:
        rows.append([_cell(c) for c in raw])
    # Trim trailing fully-empty rows that pdfplumber sometimes appends.
    while rows and not any(c for c in rows[-1]):
        rows.pop()
    return rows


def _cell(value: str | None) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _width(rows: list[list[str]]) -> int:
    return max((len(r) for r in rows), default=0)


def _row_hits(cells: list[str]) -> int:
    """How many cells in a row look like a column header."""
    hits = 0
    for c in cells:
        if not c:
            continue
        if map_header(c) is not None or parse_year(c)[0] is not None:
            hits += 1
    return hits


def _find_header(
    rows: list[list[str]],
) -> tuple[list[str], int, bool] | None:
    """
    Locate the header and return (headers, index_after_header, is_multi_row).

    Scans the first few rows for the single strongest header, and separately
    tries pairing each candidate with the row below it, because a group label
    stacked over sub labels only reads as a header once the two are combined.
    A table whose best header still resolves fewer than two columns is skipped
    rather than guessed at.
    """
    scan = min(4, len(rows))
    width = _width(rows)

    best_single_idx = -1
    best_single_score = 0
    for i in range(scan):
        score = _row_hits(rows[i])
        if score > best_single_score:
            best_single_score = score
            best_single_idx = i

    best_pair_idx = -1
    best_pair_score = 0
    best_pair_headers: list[str] = []
    for i in range(min(scan, len(rows) - 1)):
        combined = _combine_header_rows(rows[i], rows[i + 1], width)
        score = _row_hits(combined)
        if score > best_pair_score:
            best_pair_score = score
            best_pair_idx = i
            best_pair_headers = combined

    # Prefer the two-row reading only when it genuinely explains more columns.
    if best_pair_score >= 2 and best_pair_score > best_single_score:
        return best_pair_headers, best_pair_idx + 2, True

    if best_single_score >= 2:
        return list(rows[best_single_idx]), best_single_idx + 1, False

    return None


def _combine_header_rows(
    group: list[str], sub: list[str], width: int
) -> list[str]:
    """
    Merge a spanning group row into the sub-label row beneath it.

    A group label ("Exports") is printed once above the leftmost of the columns
    it covers; the cells to its right are blank. Carrying the last seen group
    label rightward reconstructs "Exports 2021", "Exports 2022", "Exports 2023"
    from "Exports | | " over "2021 | 2022 | 2023".
    """
    group = list(group) + [""] * (width - len(group))
    sub = list(sub) + [""] * (width - len(sub))
    carried = ""
    combined: list[str] = []
    for i in range(width):
        if group[i]:
            carried = group[i]
        top = carried if group[i] or (sub[i] and carried) else ""
        parts = [p for p in (top, sub[i]) if p]
        combined.append(" ".join(parts).strip())
    return combined


def _title_text(rows: list[list[str]], header_start: int) -> str:
    """Text sitting above the header, a fallback source for currency and scale."""
    parts: list[str] = []
    for r in rows[:header_start]:
        parts.extend(c for c in r if c)
    return " ".join(parts)


def _scale_of(text: str) -> tuple[float, str | None]:
    for pat, mult, label in _SCALE_PATTERNS:
        if pat.search(text):
            return mult, label
    return 1.0, None


def _rows_to_extractions(
    *,
    headers: list[str],
    data_rows: list[list[str]],
    data_start_abs: int,
    title: str,
    url: str,
    page_no: int,
    table_index: int,
) -> list[Extraction]:
    width = len(headers)
    roles = [map_header(h) if h else None for h in headers]
    col_year = [parse_year(h) if h else (None, 0.0) for h in headers]
    col_flow = [detect_flow(h) if h else (None, 0.0) for h in headers]
    col_scale = [_scale_of(h) if h else (1.0, None) for h in headers]

    measure_cols: list[int] = []
    for i in range(width):
        if roles[i] in ("value", "qty"):
            measure_cols.append(i)
        elif col_year[i][0] is not None and roles[i] not in _DIMENSION_ROLES:
            # A column headed by a bare year is a year-series measure.
            measure_cols.append(i)

    if not measure_cols:
        return []

    def col_with_role(role: str) -> int | None:
        for i in range(width):
            if roles[i] == role:
                return i
        return None

    reporter_col = col_with_role("reporter")
    partner_col = col_with_role("partner")
    product_col = col_with_role("product")
    hs_col = col_with_role("hs_code")
    flow_col = col_with_role("flow")
    currency_col = col_with_role("currency")
    year_col = col_with_role("year")
    unit_col = col_with_role("qty_unit")
    sector_col = col_with_role("sector")

    title_cur, _ = detect_currency(title) if title else (None, 0.0)
    title_scale = _scale_of(title)

    out: list[Extraction] = []
    for r_offset, row in enumerate(data_rows):
        if not any(row):
            continue
        row = list(row) + [""] * (width - len(row))
        abs_row = data_start_abs + r_offset

        reporter_name = reporter_iso3 = None
        if reporter_col is not None and row[reporter_col]:
            reporter_iso3, reporter_name = _country(row[reporter_col])
        partner_name = partner_iso3 = None
        if partner_col is not None and row[partner_col]:
            partner_iso3, partner_name = _country(row[partner_col])

        product_name = None
        row_hs = None
        if product_col is not None and row[product_col]:
            product_name = row[product_col]
            row_hs = parse_hs(row[product_col])[0]
        if hs_col is not None and row[hs_col]:
            hs_from_col = parse_hs(row[hs_col])[0]
            row_hs = hs_from_col or row_hs

        row_flow = None
        if flow_col is not None and row[flow_col]:
            row_flow = detect_flow(row[flow_col])[0]

        row_cur = None
        if currency_col is not None and row[currency_col]:
            row_cur = detect_currency(row[currency_col])[0]

        row_year = None
        if year_col is not None and row[year_col]:
            row_year = parse_year(row[year_col])[0]

        qty_unit = row[unit_col] if (unit_col is not None and row[unit_col]) else None
        sector = row[sector_col] if (sector_col is not None and row[sector_col]) else None

        for col in measure_cols:
            raw = row[col] if col < len(row) else ""
            if not raw:
                continue
            # The heading is passed as context so the separator convention can
            # be settled from it. A comma before three digits is ambiguous on
            # its own, and the language of the heading resolves it.
            num = parse_number(raw, context=headers[col] if col < len(headers) else None)
            if num is None:
                continue

            mult, scale_label = col_scale[col]
            if scale_label is None:
                mult, scale_label = title_scale
            scaled = num * mult

            year = col_year[col][0] if col_year[col][0] is not None else row_year
            flow = col_flow[col][0] if col_flow[col][0] is not None else row_flow
            header = headers[col]
            cur = row_cur or detect_currency(header)[0] or title_cur

            # A measure needs at least one thing describing what it counts.
            has_dimension = any(
                x is not None
                for x in (year, flow, row_hs, reporter_iso3, partner_iso3, product_name)
            )
            if not has_dimension:
                continue

            ext = Extraction(
                reporter_name=reporter_name,
                reporter_iso3=reporter_iso3,
                partner_name=partner_name,
                partner_iso3=partner_iso3,
                flow=flow,
                hs_code=row_hs,
                product_name=product_name,
                sector=sector,
                year=year,
                currency=cur,
                provenance=Provenance(
                    source_url=url,
                    source_type=SourceType.PDF_TEXT,
                    extractor=_EXTRACTOR,
                    page=page_no,
                    table_index=table_index,
                    row_index=abs_row,
                    raw_value=raw,
                    raw_label=header or None,
                ),
            )
            if roles[col] == "qty":
                ext.qty = scaled
                ext.qty_unit = qty_unit
            else:
                ext.value = scaled
                if cur == "USD":
                    ext.value_usd = scaled
                    ext.usd_basis = "reported"
            if scale_label is not None:
                ext.flags.append(f"scale:{scale_label}")
            out.append(ext)

    return out


def _country(name: str) -> tuple[str | None, str | None]:
    """resolve_country returns two strings; pick the one that is an ISO3 code."""
    a, b, _conf = resolve_country(name)
    iso3, canonical = None, None
    for value in (a, b):
        if value and re.fullmatch(r"[A-Z]{3}", value):
            iso3 = value
        elif value:
            canonical = value
    return iso3, (canonical or name)


def _add_flag(exts: list[Extraction], flag: str) -> None:
    for e in exts:
        if flag not in e.flags:
            e.flags.append(flag)


def _guard_open(data: bytes, url: str) -> list[Extraction] | None:
    """Return a sentinel when the PDF is encrypted and cannot be read."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception:
        return _sentinel(url, "pdf:corrupt")
    if reader.is_encrypted:
        try:
            # Many statistical PDFs are encrypted only to set permissions and
            # open with an empty password. A real password cannot be guessed.
            if not reader.decrypt(""):
                return _sentinel(url, "pdf:encrypted")
        except Exception:
            return _sentinel(url, "pdf:encrypted")
    return None


def _sentinel(url: str, flag: str) -> list[Extraction]:
    """
    A single record carrying only a flag, so an unreadable document is visible.

    It holds no value and no dimensions, so it can never be mistaken for data,
    but the flag survives to tell a caller why nothing came out.
    """
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
