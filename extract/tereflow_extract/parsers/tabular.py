"""
Turn a delimited or spreadsheet file into trade observations.

The hard part of real statistical files is never the parsing library, it is
that the grid on disk is rarely the grid you want. Agency spreadsheets carry
title blocks, logos and footnotes above the real headers, spread a single
report across many sheets, and pivot years or partners out into columns. This
module treats all of that as the normal case: it locates the header row by
evidence rather than position, reads every sheet, and reshapes wide layouts
back to one observation per row before mapping anything.

Nothing here judges a value. It records what the cell said, where it sat, and
how it was read, and leaves confidence and currency conversion to later stages.
"""

from __future__ import annotations

import csv
import io
import logging
import math
import re

import pandas as pd

from ..contracts import Extraction, Provenance, SourceType
from ..normalize.numbers import MAGNITUDE, parse_number, parse_number_with_scale
from ..normalize.currency import detect_currency
from ..normalize.countries import resolve_country
from ..normalize.commodities import parse_hs
from ..normalize.fields import map_header, detect_flow, parse_year

log = logging.getLogger("tereflow.parsers.tabular")

EXTRACTOR = "tabular"

# How far down to look for the real header before giving up. Statistical
# preambles run long, but a header that has not appeared in twenty rows is a
# sign the file is not the table it claimed to be.
_HEADER_SCAN_ROWS = 20

# A header row has to earn its place. One stray recognised word in a title
# line should not be mistaken for column headers.
_MIN_HEADER_HITS = 2

# Enough year columns to be confident the layout is pivoted rather than a lone
# column that happens to be named after a year.
_MIN_YEAR_COLS = 2

_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP_MAGIC = b"PK\x03\x04"

_WORLD_RE = re.compile(
    r"^(world|all\s+countries|all\s+partners|all\s+trading\s+partners|total\s+world)$",
    re.I,
)
_TOTAL_RE = re.compile(
    r"^(sub[\s-]?total|grand\s+total|total|totals|sum|all)$",
    re.I,
)


def parse_tabular(
    data: bytes,
    source_type: SourceType,
    url: str,
    *,
    filename: str | None = None,
) -> list[Extraction]:
    """Read one delimited or spreadsheet file into a flat list of observations."""
    try:
        tables = _load_tables(data, source_type, filename)
    except Exception:
        # A file that cannot even be opened yields nothing, but the reason is
        # worth keeping so a bad source can be traced rather than guessed at.
        log.exception("failed to open tabular file url=%s", url)
        return []

    out: list[Extraction] = []
    for table in tables:
        try:
            out.extend(_parse_one_table(table, url, source_type))
        except Exception:
            # One unreadable sheet must not sink the sheets that are fine.
            log.exception(
                "failed to parse table index=%s locator=%s url=%s",
                table.get("table_index"),
                table.get("locator"),
                url,
            )
            continue
    return out


def _load_tables(
    data: bytes, source_type: SourceType, filename: str | None
) -> list[dict]:
    """
    Get the raw grid of every table in the file, headers not yet resolved.

    Rows are returned exactly as they sit on disk so that a row index reported
    later points at the real line in the source, not at some cleaned copy.
    """
    is_excel = source_type == SourceType.EXCEL or data[:8].startswith(_OLE2_MAGIC) or (
        data[:4] == _ZIP_MAGIC and source_type != SourceType.CSV
    )
    if is_excel:
        return _load_excel(data, filename)
    return _load_csv(data)


def _load_csv(data: bytes) -> list[dict]:
    text, enc = _decode(data)
    delim, delim_name = _pick_delimiter(text)
    rows: list[list[str]] = []
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    for row in reader:
        rows.append([c for c in row])
    return [
        {
            "table_index": 0,
            "locator": f"delimiter:{delim_name}",
            "rows": rows,
            "encoding": enc,
        }
    ]


def _load_excel(data: bytes, filename: str | None) -> list[dict]:
    engine = _excel_engine(data, filename)
    frames = pd.read_excel(
        io.BytesIO(data), sheet_name=None, header=None, engine=engine, dtype=object
    )
    tables: list[dict] = []
    for idx, (sheet_name, df) in enumerate(frames.items()):
        rows = df.values.tolist() if not df.empty else []
        tables.append(
            {
                "table_index": idx,
                "locator": str(sheet_name),
                "rows": rows,
                "encoding": None,
            }
        )
    return tables


def _excel_engine(data: bytes, filename: str | None) -> str:
    if data[:8].startswith(_OLE2_MAGIC):
        return "xlrd"
    if data[:4] == _ZIP_MAGIC:
        head = data[:4096]
        if b"opendocument.spreadsheet" in head or (
            filename and filename.lower().endswith(".ods")
        ):
            return "odf"
        return "openpyxl"
    if filename:
        low = filename.lower()
        if low.endswith(".ods"):
            return "odf"
        if low.endswith(".xls"):
            return "xlrd"
    return "openpyxl"


def _parse_one_table(
    table: dict, url: str, source_type: SourceType
) -> list[Extraction]:
    rows: list[list] = table["rows"]
    if not rows:
        return []

    header_idx = _find_header_row(rows)
    if header_idx is None:
        # No row looked like column headers. Emitting anything now would be
        # inventing structure the file does not have.
        return []

    header = [_cell_text(c) for c in rows[header_idx]]
    data_rows = [(i, rows[i]) for i in range(header_idx + 1, len(rows))]

    year_cols = [
        j
        for j, h in enumerate(header)
        if map_header(h) is None and parse_year(h)[0] is not None
    ]
    if len(year_cols) >= _MIN_YEAR_COLS:
        return _parse_wide(table, url, source_type, header, data_rows, year_cols)
    return _parse_long(table, url, source_type, header, data_rows)


def _find_header_row(rows: list[list]) -> int | None:
    """
    Pick the row that most looks like column headers.

    Score is the count of cells that resolve to a known field or to a year, so
    a pivoted header of one label plus several years is recognised as readily
    as a plain one. The earliest best-scoring row wins, because a real header
    sits above its data and any later match is usually a repeated label.
    """
    best_idx: int | None = None
    best_score = 0
    limit = min(_HEADER_SCAN_ROWS, len(rows))
    for i in range(limit):
        score = 0
        for cell in rows[i]:
            text = _cell_text(cell)
            if not text:
                continue
            if map_header(text) is not None or parse_year(text)[0] is not None:
                score += 1
        if score > best_score:
            best_score = score
            best_idx = i
    if best_idx is None or best_score < _MIN_HEADER_HITS:
        return None
    return best_idx


def _column_map(header: list[str]) -> dict[str, int]:
    """First column index for each canonical field it recognises."""
    cols: dict[str, int] = {}
    for j, h in enumerate(header):
        canon = map_header(h)
        if canon and canon not in cols:
            cols[canon] = j
    return cols


def _parse_long(
    table: dict,
    url: str,
    source_type: SourceType,
    header: list[str],
    data_rows: list[tuple[int, list]],
) -> list[Extraction]:
    cols = _column_map(header)
    value_col = cols.get("value")
    if value_col is None:
        # A trade table with no value column carries no fact this pipeline can
        # use. Skip it rather than emit rows with an empty measure.
        log.info("table has no value column locator=%s", table.get("locator"))
        return []

    out: list[Extraction] = []
    for src_idx, cells in data_rows:
        value_raw = _cell_at(cells, value_col)
        # The header, not just the cell. Statistical tables state the magnitude
        # once in the column heading and then print bare numbers, so a column
        # headed "Value (US$ thousand)" holding "412300" means 412.3 million.
        # Reading the cell alone understates every figure in that column by the
        # size of the word, silently and consistently.
        value_header = header[value_col] if value_col < len(header) else None
        value, scale_note = parse_number_with_scale(
            _num_input(cells, value_col), value_header
        )
        if value is None:
            # A cell that will not parse is never coerced to zero.
            continue

        # A magnitude given per row, in its own column. Applied only when the
        # heading did not already carry one, so the multiplier is never used
        # twice on the same figure.
        scale_col = cols.get("scale")
        if scale_col is not None and scale_note is None:
            row_scale = _row_scale(_cell_at(cells, scale_col))
            if row_scale:
                factor, word = row_scale
                value *= factor
                scale_note = f"scale-from-column:{word}"

        partner_text = _cell_at(cells, cols.get("partner"))
        world = cols.get("partner") is not None and _is_world(partner_text)
        if not world and _is_any_total(
            partner_text,
            _cell_at(cells, cols.get("reporter")),
            _cell_at(cells, cols.get("product")),
        ):
            continue

        ext = _make_extraction(
            url=url,
            source_type=source_type,
            table_index=table["table_index"],
            row_index=src_idx,
            locator=table["locator"],
            value=value,
            value_raw_text=value_raw,
            value_label=value_header,
            reporter_text=_cell_at(cells, cols.get("reporter")),
            partner_text=partner_text,
            product_text=_cell_at(cells, cols.get("product")),
            hs_text=_cell_at(cells, cols.get("hs_code")),
            flow_text=_cell_at(cells, cols.get("flow")),
            currency_text=_cell_at(cells, cols.get("currency")),
            year=parse_year(_cell_at(cells, cols.get("year")))[0]
            if cols.get("year") is not None
            else None,
            qty=parse_number(_num_input(cells, cols.get("qty")))
            if cols.get("qty") is not None
            else None,
            qty_unit_text=_cell_at(cells, cols.get("qty_unit")),
            sector_text=_cell_at(cells, cols.get("sector")),
            world_total=world,
            extra_flags=[scale_note] if scale_note else [],
            encoding=table.get("encoding"),
        )
        out.append(ext)
    return out


def _parse_wide(
    table: dict,
    url: str,
    source_type: SourceType,
    header: list[str],
    data_rows: list[tuple[int, list]],
    year_cols: list[int],
) -> list[Extraction]:
    """
    Melt a year-pivoted table so each observation lands on its own row.

    The identity columns (partner, product and the like) repeat for every year
    column, and each year cell becomes one observation carrying that column
    header as its year. The original source row index is preserved so the
    provenance still points at the physical line the numbers came from.
    """
    id_cols = _column_map([h if j not in year_cols else "" for j, h in enumerate(header)])

    # Where the magnitude is stated for the whole table. Only non-year headers
    # and the table's own label are considered, because a year column heading
    # is a bare number and carries no scale.
    wide_scale_hint = " ".join(
        str(h) for j, h in enumerate(header) if j not in year_cols and h
    )
    if table.get("title"):
        wide_scale_hint = f"{table['title']} {wide_scale_hint}"

    out: list[Extraction] = []
    for src_idx, cells in data_rows:
        partner_text = _cell_at(cells, id_cols.get("partner"))
        world = id_cols.get("partner") is not None and _is_world(partner_text)
        if not world and _is_any_total(
            partner_text,
            _cell_at(cells, id_cols.get("reporter")),
            _cell_at(cells, id_cols.get("product")),
        ):
            continue

        for j in year_cols:
            # A wide table states its magnitude once, and not in the year
            # headings, which are just years. It is usually in a title row or
            # one of the identifier columns, so the hint is drawn from those.
            value, scale_note = parse_number_with_scale(
                _num_input(cells, j), wide_scale_hint
            )
            if value is None:
                continue
            year = parse_year(header[j])[0] if j < len(header) else None
            ext = _make_extraction(
                url=url,
                source_type=source_type,
                table_index=table["table_index"],
                row_index=src_idx,
                locator=table["locator"],
                value=value,
                value_raw_text=_cell_at(cells, j),
                value_label=header[j] if j < len(header) else None,
                reporter_text=_cell_at(cells, id_cols.get("reporter")),
                partner_text=partner_text,
                product_text=_cell_at(cells, id_cols.get("product")),
                hs_text=_cell_at(cells, id_cols.get("hs_code")),
                flow_text=_cell_at(cells, id_cols.get("flow")),
                currency_text=_cell_at(cells, id_cols.get("currency")),
                year=year,
                qty=parse_number(_num_input(cells, id_cols.get("qty")))
                if id_cols.get("qty") is not None
                else None,
                qty_unit_text=_cell_at(cells, id_cols.get("qty_unit")),
                sector_text=_cell_at(cells, id_cols.get("sector")),
                world_total=world,
                extra_flags=["reshaped:wide-to-long"] + ([scale_note] if scale_note else []),
                encoding=table.get("encoding"),
            )
            out.append(ext)
    return out


def _make_extraction(
    *,
    url: str,
    source_type: SourceType,
    table_index: int,
    row_index: int,
    locator: str,
    value: float,
    value_raw_text: str,
    value_label: str | None,
    reporter_text: str,
    partner_text: str,
    product_text: str,
    hs_text: str,
    flow_text: str,
    currency_text: str,
    year: int | None,
    qty: float | None,
    qty_unit_text: str,
    sector_text: str,
    world_total: bool,
    extra_flags: list[str],
    encoding: str | None,
) -> Extraction:
    reporter_name = reporter_iso3 = None
    if reporter_text:
        iso, canon, _ = resolve_country(reporter_text)
        reporter_iso3 = iso
        reporter_name = canon or reporter_text

    if world_total:
        # A world total is a real partner row when the rest of the table breaks
        # partners out, so it is kept and labelled rather than dropped.
        partner_name, partner_iso3 = "World", None
    else:
        partner_name = partner_iso3 = None
        if partner_text:
            iso, canon, _ = resolve_country(partner_text)
            partner_iso3 = iso
            partner_name = canon or partner_text

    product_name = product_text or None
    hs_code = None
    if hs_text:
        hs_code = parse_hs(hs_text)[0]
    elif product_text:
        code, _ = parse_hs(product_text)
        if code:
            hs_code = code

    flow = None
    for cand in (flow_text, value_label):
        if not cand:
            continue
        f, _ = detect_flow(cand)
        if f:
            flow = f
            break

    # Currency is only ever taken from something the source actually printed:
    # a currency column, the value header, or a symbol in the cell itself.
    currency = None
    value_usd = None
    usd_basis = None
    for cand in (currency_text, value_label, value_raw_text):
        if not cand:
            continue
        iso, conf = detect_currency(cand)
        if iso and conf > 0:
            currency = iso
            break
    if currency == "USD":
        value_usd = value
        usd_basis = "reported"

    flags = list(extra_flags)
    if world_total:
        flags.append("world-total")
    if encoding and encoding.lower() not in ("utf-8", "ascii"):
        flags.append(f"encoding:{encoding}")

    prov = Provenance(
        source_url=url,
        source_type=source_type,
        extractor=EXTRACTOR,
        table_index=table_index,
        row_index=row_index,
        locator=locator,
        raw_value=value_raw_text or None,
        raw_label=value_label,
    )

    return Extraction(
        reporter_name=reporter_name,
        reporter_iso3=reporter_iso3,
        partner_name=partner_name,
        partner_iso3=partner_iso3,
        flow=flow,
        hs_code=hs_code,
        product_name=product_name,
        sector=sector_text or None,
        value=value,
        currency=currency,
        value_usd=value_usd,
        usd_basis=usd_basis,
        qty=qty,
        qty_unit=qty_unit_text or None,
        year=year,
        flags=flags,
        provenance=prov,
    )


def _decode(data: bytes) -> tuple[str, str]:
    """
    Get text out of unknown bytes without ever letting a decode error escape.

    UTF-8 is tried strictly first because a clean decode is proof, not a guess.
    Only when that fails does chardet get a say, and even then the final decode
    replaces bad bytes rather than raising, so a single corrupt character can
    never cost the whole file.
    """
    try:
        text = data.decode("utf-8-sig")
        return _strip_bom(text), "utf-8"
    except UnicodeDecodeError:
        pass
    enc = "utf-8"
    try:
        import chardet

        guess = chardet.detect(data)
        if guess and guess.get("encoding"):
            enc = guess["encoding"]
    except Exception:
        log.debug("chardet unavailable or failed, falling back to utf-8 replace")
    return _strip_bom(data.decode(enc, errors="replace")), enc


def _row_scale(text: str) -> tuple[float, str] | None:
    """
    A magnitude word standing alone in its own cell.

    Only a bare word is accepted. A cell reading "millions" is a scale; a cell
    reading "millions of tonnes" is a unit of quantity and multiplying a money
    column by it would be wrong.
    """
    if not text:
        return None
    s = re.sub(r"[^a-z]", "", str(text).strip().lower())
    if not s:
        return None
    factor = MAGNITUDE.get(s)
    if factor is None and s.endswith("s"):
        factor = MAGNITUDE.get(s[:-1])
    return (factor, s) if factor else None


def _strip_bom(text: str) -> str:
    """
    Take the byte order mark off the front.

    Excel writes one on every CSV it exports and so do most government
    statistical portals, which means it is on the first header cell of a large
    share of these sources. Left in place it does not look like anything: the
    cell reads as REF_DATE on screen while comparing unequal to "REF_DATE",
    so the column simply fails to map and every row silently loses that field.
    On the StatCan merchandise trade table that was 519,948 rows losing their
    year, with no error anywhere to say why.
    """
    return text.lstrip("\ufeff")


def _pick_delimiter(text: str) -> tuple[str, str]:
    """
    Work out the delimiter instead of assuming a comma.

    European statistical exports use semicolons as often as commas, so the
    choice is made on evidence. The score for a candidate ignores lines where
    it does not appear at all, because title and footnote lines carry no
    delimiter and would otherwise drown out a real one. Among the lines that do
    contain the candidate it rewards a consistent column count, a higher count
    (more columns), and appearing on more of the sampled lines, so a lone rogue
    line with many delimiters cannot win.
    """
    sample_lines = [ln for ln in text.splitlines() if ln.strip()][:30]
    if not sample_lines:
        return (",", "comma")
    candidates = ((",", "comma"), (";", "semicolon"), ("\t", "tab"), ("|", "pipe"))
    best = (",", "comma")
    best_score = -1.0
    for delim, name in candidates:
        counts = [ln.count(delim) for ln in sample_lines]
        nonzero = [c for c in counts if c > 0]
        if not nonzero:
            continue
        modal = max(set(nonzero), key=nonzero.count)
        if modal < 1:
            continue
        consistency = nonzero.count(modal) / len(nonzero)
        coverage = len(nonzero) / len(sample_lines)
        score = consistency * modal * coverage
        if score > best_score:
            best_score = score
            best = (delim, name)
    return best


def _cell_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and math.isnan(v):
        return ""
    try:
        if pd.isna(v):
            return ""
    except (TypeError, ValueError):
        pass
    return str(v).strip()


def _cell_at(cells: list, j: int | None) -> str:
    if j is None or j < 0 or j >= len(cells):
        return ""
    return _cell_text(cells[j])


def _num_input(cells: list, j: int | None):
    """Hand parse_number the original number when there is one, else the text."""
    if j is None or j < 0 or j >= len(cells):
        return ""
    v = cells[j]
    if isinstance(v, bool):
        return ""
    if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
        return v
    return _cell_text(v)


def _is_world(text: str) -> bool:
    return bool(text) and _WORLD_RE.match(text.strip()) is not None


def _is_any_total(*texts: str) -> bool:
    for t in texts:
        if t and _TOTAL_RE.match(t.strip()):
            return True
    return False
