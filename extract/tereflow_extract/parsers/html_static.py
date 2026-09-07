"""
Pulling trade numbers out of HTML tables, and readable prose out of the rest.

Two jobs, both feeding the same pipeline the spreadsheet and PDF parsers feed.

`parse_html_tables` treats every <table> on a page as a candidate spreadsheet
and holds it to the same standard: find the row that is really the header, and
if fewer than two of its cells are headers a trade table would have, throw the
table away. Pages are full of tables that are not data. Layout grids, navigation
menus, and summary boxes are all <table> elements to a browser, and handing one
of those to a value parser produces rows of nonsense that look like facts. The
two-header rule, the one-row and one-column rule, and the must-contain-a-number
rule together keep furniture out.

`extract_main_text` does the opposite: it drops the tables, the navigation, the
cookie banners, and the footers, and returns the article body, so a caller can
scan prose for a trade statement the same way the PDF text parser does. It is
deliberately thin. It hands back text and decides nothing.

The hard rules hold here as everywhere. A cell that will not parse leaves its
field None, never zero. Currency is set only when the header, the caption, or a
unit note on the page states it, and value_usd stays None unless that stated
currency is US dollars. Confidence is left at zero for a later module to set.
Malformed markup returns an empty list, never an exception.
"""

from __future__ import annotations

from io import StringIO

import pandas as pd
from bs4 import BeautifulSoup

from ..contracts import Extraction, Provenance, SourceType

# These live in modules another worker owns. They are imported at the top, to
# the exact signatures agreed, so this file breaks loudly if a signature drifts
# rather than quietly mis-reading a column.
from ..normalize.numbers import parse_number, parse_number_with_scale
from ..normalize.currency import detect_currency
from ..normalize.countries import resolve_country
from ..normalize.commodities import parse_hs
from ..normalize.fields import map_header
from ..normalize.fields import detect_flow
from ..normalize.fields import parse_year


_EXTRACTOR = "html_static"


def parse_html_tables(html: bytes, url: str) -> list[Extraction]:
    """
    Read every real data table on the page into Extraction rows.

    Tables that are page furniture are skipped, not emitted empty, so a caller
    never has to tell a layout grid apart from a dataset after the fact. Any
    failure to parse the markup returns an empty list.
    """
    if not html:
        return []

    text = html.decode("utf-8", errors="replace")
    frames = _read_tables(text)
    if not frames:
        return []

    # A table's caption and the heading above it are where a page states the
    # currency and the units, which pandas discards. They are read separately
    # and matched back by position so per-table context is available.
    contexts = _table_contexts(html)

    out: list[Extraction] = []
    for table_index, df in enumerate(frames):
        ctx = contexts[table_index] if table_index < len(contexts) else ""
        out.extend(_rows_from_frame(df, table_index, url, ctx))
    return out


def extract_main_text(html: bytes, url: str) -> str:
    """
    Return the readable body of the page, boilerplate removed.

    Thin on purpose. It strips navigation, ads, and chrome with trafilatura and
    hands back the prose. What to do with that prose is the caller's decision,
    the same way the PDF text parser leaves interpretation to a later scan.
    """
    if not html:
        return ""
    try:
        import trafilatura
    except Exception:
        return ""
    try:
        text = html.decode("utf-8", errors="replace")
        out = trafilatura.extract(text, url=url or None)
        return out or ""
    except Exception:
        return ""


def _read_tables(text: str) -> list[pd.DataFrame] | None:
    """
    Parse tables with lxml, falling back to html5lib for broken markup.

    lxml is fast and strict; html5lib is slow and forgiving and can read the
    kind of unclosed-tag soup some government portals emit. Trying lxml first
    keeps the common case quick without losing the messy pages.
    """
    for flavor in ("lxml", "html5lib"):
        try:
            frames = pd.read_html(StringIO(text), flavor=flavor)
            if frames:
                return frames
        except Exception:
            continue
    return None


def _rows_from_frame(
    df: pd.DataFrame, table_index: int, url: str, ctx: str
) -> list[Extraction]:
    if df is None or df.empty:
        return []

    ncols = df.shape[1]
    if ncols < 2:
        # One column is a list, not a table of observations.
        return []

    header = _resolve_headers(df)
    if header is None:
        return []
    distinct, kind, header_cells, header_row, mapping = header
    if distinct < 2:
        # Fewer than two recognised headers means this is not a trade table,
        # whatever else it is.
        return []

    values = df.values.tolist()
    data = values if kind == "columns" else values[header_row + 1 :]
    if not data:
        return []

    if not _has_numeric(data):
        # A table with no number anywhere is a layout grid or a text block.
        return []

    value_pos = _pos_for(mapping, "value")
    currency_pos = _pos_for(mapping, "currency")
    value_header = header_cells[value_pos] if value_pos is not None else None

    out: list[Extraction] = []
    for row_index, row in enumerate(data):
        ext = _row_to_extraction(
            row=row,
            mapping=mapping,
            header_cells=header_cells,
            ctx=ctx,
            value_pos=value_pos,
            currency_pos=currency_pos,
            value_header=value_header,
            table_index=table_index,
            row_index=row_index,
            url=url,
        )
        if ext is not None:
            out.append(ext)
    return out


def _row_to_extraction(
    *,
    row,
    mapping,
    header_cells,
    ctx,
    value_pos,
    currency_pos,
    value_header,
    table_index,
    row_index,
    url,
) -> Extraction | None:
    ext = Extraction()
    established = False
    raw_value: str | None = None
    raw_label: str | None = None

    # A currency named in its own column is stated per row and is the most
    # specific evidence there is, so it is read before the value.
    row_currency: str | None = None
    if currency_pos is not None and currency_pos < len(row):
        cur_cell = _cell_str(row[currency_pos])
        if cur_cell:
            cur, _ = detect_currency(cur_cell)
            if cur:
                row_currency = cur

    for pos, fieldname in mapping.items():
        if pos >= len(row):
            continue
        cell = row[pos]
        s = _cell_str(cell)
        if not s:
            continue

        if fieldname == "reporter":
            ext.reporter_name = s
            iso3, name = _split_country(resolve_country(s))
            if iso3:
                ext.reporter_iso3 = iso3
            if name:
                ext.reporter_name = name
            established = True

        elif fieldname == "partner":
            ext.partner_name = s
            iso3, name = _split_country(resolve_country(s))
            if iso3:
                ext.partner_iso3 = iso3
            if name:
                ext.partner_name = name
            established = True

        elif fieldname == "product":
            ext.product_name = s
            hs, _ = parse_hs(s)
            if hs:
                ext.hs_code = hs
            established = True

        elif fieldname == "hs_code":
            hs, _ = parse_hs(s)
            if hs:
                ext.hs_code = hs
                established = True

        elif fieldname == "sector":
            ext.sector = s
            established = True

        elif fieldname == "flow":
            flow, _ = detect_flow(s)
            if flow:
                ext.flow = flow
                established = True

        elif fieldname == "year":
            yr, _ = parse_year(s)
            if yr is not None:
                ext.year = yr
                established = True

        elif fieldname == "value":
            # Scale from the column heading, not just the cell. A column headed
            # "Value (US$ million)" holding a bare "1,204" means 1.204 billion,
            # and reading the cell alone understates it by a million.
            label = _cell_str(value_header) or None
            v, scale_note = parse_number_with_scale(cell, label)
            if v is not None:
                ext.value = v
                raw_value = s
                raw_label = label
                if scale_note:
                    ext.flags.append(scale_note)
                established = True

        elif fieldname == "qty":
            q = parse_number(cell)
            if q is not None:
                ext.qty = q
                established = True

        elif fieldname == "qty_unit":
            ext.qty_unit = s
            established = True

    if not established:
        # Nothing in this row mapped to a fact. It is a spacer or a subtotal
        # blank, not an observation to invent one from.
        return None

    # Currency is only ever taken from what the page said: a dedicated column,
    # or failing that the value header and the caption context. It is never
    # assumed. Without it, value_usd stays None.
    if row_currency:
        ext.currency = row_currency
    elif ext.value is not None:
        cur, _ = detect_currency(f"{_cell_str(value_header)} {ctx}")
        if cur:
            ext.currency = cur

    if ext.currency == "USD" and ext.value is not None:
        ext.value_usd = ext.value
        ext.usd_basis = "reported"

    ext.provenance = Provenance(
        source_url=url,
        source_type=SourceType.HTML_STATIC,
        extractor=_EXTRACTOR,
        table_index=table_index,
        row_index=row_index,
        locator=f"table[{table_index}]",
        raw_value=raw_value,
        raw_label=raw_label,
    )
    return ext


def _resolve_headers(df: pd.DataFrame):
    """
    Find which row is really the header and what its cells mean.

    The header is not always the DataFrame's column labels: pandas may have
    read a title banner or a units row as row zero. So the column labels and
    the first several rows are all tried as the header, and whichever yields
    the most recognised trade columns wins. Returned as
    (distinct_recognised, kind, header_cells, header_row_index, position_map).
    """
    col_labels = [_flat(c) for c in df.columns]
    candidates = [("columns", col_labels, -1)]

    values = df.values.tolist()
    for i in range(min(len(values), 5)):
        candidates.append(("row", [_cell_str(x) for x in values[i]], i))

    best = None
    for kind, cells, ridx in candidates:
        mapping: dict[int, str] = {}
        for pos, cell in enumerate(cells):
            text = _cell_str(cell)
            if not text:
                continue
            field = map_header(text)
            if field:
                mapping[pos] = field
        distinct = len(set(mapping.values()))
        if best is None or distinct > best[0]:
            best = (distinct, kind, cells, ridx, mapping)

    return best


def _table_contexts(html: bytes) -> list[str]:
    """
    The caption and nearest heading for each table, in document order.

    This is where currency and units are usually stated ("Values in thousands
    of USD"), and pandas throws it away. Kept as a best-effort parallel read so
    per-table currency detection has something to work from.
    """
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return []

    out: list[str] = []
    for table in soup.find_all("table"):
        parts: list[str] = []
        caption = table.find("caption")
        if caption is not None:
            parts.append(caption.get_text(" ", strip=True))
        node = table
        for _ in range(4):
            node = node.find_previous(["h1", "h2", "h3", "h4", "figcaption"])
            if node is None:
                break
            txt = node.get_text(" ", strip=True)
            if txt:
                parts.append(txt)
                break
        out.append(" ".join(" ".join(parts).split())[:400])
    return out


def _has_numeric(rows) -> bool:
    for row in rows:
        for cell in row:
            if _looks_numeric(cell):
                return True
    return False


def _looks_numeric(cell) -> bool:
    """
    A local numeric sniff for the layout-table gate.

    Deliberately independent of parse_number so the decision to keep or drop a
    whole table does not depend on a normalize module that may be stubbed. It
    only asks "could this be a number", not "what number is it".
    """
    if isinstance(cell, (int, float)):
        return cell == cell  # rejects NaN, which is not equal to itself
    s = _cell_str(cell)
    if not s:
        return False
    stripped = s.replace(",", "").replace(" ", "").replace("%", "")
    for sym in ("$", "€", "£", "¥"):
        stripped = stripped.replace(sym, "")
    if stripped.startswith(("(", "-", "+")):
        stripped = stripped[1:]
    stripped = stripped.rstrip(")")
    if not stripped:
        return False
    try:
        float(stripped)
        return True
    except ValueError:
        return False


def _pos_for(mapping: dict[int, str], field: str) -> int | None:
    for pos, name in mapping.items():
        if name == field:
            return pos
    return None


def _split_country(result) -> tuple[str | None, str | None]:
    """
    Pull iso3 and name out of resolve_country's tuple without trusting order.

    The three-element return is (something, something, confidence), and which
    of the first two is the code is not worth depending on. The ISO3 is the
    element that is three alphabetic uppercase letters; the other string is the
    name. Reading it this way survives either ordering.
    """
    try:
        a, b = result[0], result[1]
    except (TypeError, IndexError):
        return None, None
    iso3: str | None = None
    name: str | None = None
    for x in (a, b):
        if isinstance(x, str) and len(x) == 3 and x.isalpha() and x.isupper():
            iso3 = x
        elif isinstance(x, str) and x.strip():
            name = x.strip()
    return iso3, name


def _flat(col) -> str:
    """Flatten a possibly-MultiIndex column label to one searchable string."""
    if isinstance(col, tuple):
        parts = [str(p) for p in col if p is not None and not _is_unnamed(p)]
        return " ".join(parts).strip()
    return _cell_str(col)


def _is_unnamed(part) -> bool:
    return isinstance(part, str) and part.startswith("Unnamed:")


def _cell_str(cell) -> str:
    if cell is None:
        return ""
    if isinstance(cell, float) and cell != cell:
        # NaN prints as "nan"; treat it as an empty cell so it never becomes a
        # header word or a raw value.
        return ""
    return str(cell).strip()
