"""Load sectoral credit from a spreadsheet, for countries whose central bank has no feed we can call.

An operator copies a country's published figures into the Tereflow workbook (same shape as the Bank of Ghana series:
one column per series, one row per period) and the pipeline checks it with the same rules as a live feed, then stores it
as its own source ("FILE"). Nothing here guesses: a bad cell refuses the whole file with every problem listed by sheet and
row, a blank cell is missing (never zero), and a file is never merged with another source.

Workbook sheets (names are not case sensitive; other sheets, such as Example and How to fill, are ignored):
  Source  two columns, field and value: country_iso3, currency, source_name, source_url (optional), frequency
  Series  one row per series: mnemonic, sector_key, sector_name, role, unit_label, multiplier_to_millions, measure_kind, definition_notes
  Data    first column "period", then one column per mnemonic from the Series sheet
Values must be pasted as numbers (not formulas). Pure functions; openpyxl is imported only when a workbook is opened.
"""
from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from . import credit as C

MAX_SERIES, MAX_ROWS = 200, 6000
FREQ_WORDS = {"M": "M", "MONTHLY": "M", "Q": "Q", "QUARTERLY": "Q", "A": "A", "ANNUAL": "A", "YEARLY": "A", "ANNUALLY": "A"}
MONTH_ABBR = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
ROLES = ("total", "sector")
KINDS = ("stock", "flow", "unverified")
NULLS = {"", "na", "n/a", "nan", "null", "none", "-", "--", ".."}   # blank is missing; these words are treated as blank too


@dataclass
class FileSeries:
    mnemonic: str
    sector_key: str
    sector_name: str
    role: str
    unit_label: str
    multiplier: float
    measure_kind: str  # "" means: let the pipeline infer it, and say so
    notes: str
    obs: list = field(default_factory=list)  # list[credit.Obs]


@dataclass
class FileParse:
    filename: str
    sha256: str
    country: str = ""
    currency: str = ""
    source_name: str = ""
    source_url: str = ""
    frequency: str = ""
    series: list = field(default_factory=list)
    problems: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems and bool(self.series)


# ---------------------------------------------------------------------------------------------------------------
# Cells
# ---------------------------------------------------------------------------------------------------------------

def _text(v) -> str:
    return "" if v is None else str(v).strip()


def _norm_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s).strip().lower()).strip("_")


def parse_period(v, freq: str) -> str:
    """One period cell to a period key (2026-09, 2026-Q3 or 2026). The cell must match the declared frequency."""
    if v is None or (isinstance(v, str) and not v.strip()):
        raise ValueError("the period is empty")
    if isinstance(v, (datetime, date)):
        if freq == "M":
            return f"{v.year:04d}-{v.month:02d}"
        if freq == "Q":
            return f"{v.year:04d}-Q{(v.month - 1) // 3 + 1}"
        return f"{v.year:04d}"
    if isinstance(v, bool):
        raise ValueError(f"'{v}' is not a period")
    if isinstance(v, (int, float)):
        if freq == "A" and float(v).is_integer() and 1900 <= int(v) <= 2100:
            return f"{int(v):04d}"
        raise ValueError(f"'{v}' is a bare number, not a period; type the period as text (for example 2026-09) or use a date")
    s = str(v).strip()
    if freq == "M":
        m = re.fullmatch(r"(\d{4})[-/](\d{1,2})", s)
        if m and 1 <= int(m.group(2)) <= 12:
            return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}"
        m = re.fullmatch(r"([A-Za-z]{3,9})[-\s']*(\d{2}|\d{4})", s)
        if m and m.group(1)[:3].lower() in MONTH_ABBR:
            y = int(m.group(2))
            if y < 100:
                y = 1900 + y if y >= 70 else 2000 + y
            return f"{y:04d}-{MONTH_ABBR[m.group(1)[:3].lower()]:02d}"
        raise ValueError(f"'{s}' is not a month; use 2026-09 or Sep-26 for a monthly file")
    if freq == "Q":
        m = re.fullmatch(r"(\d{4})\s*-?\s*[Qq]([1-4])", s) or re.fullmatch(r"[Qq]([1-4])\s*-?\s*(\d{4})", s)
        if m:
            a, b = m.groups()
            y, q = (a, b) if len(a) == 4 else (b, a)
            return f"{int(y):04d}-Q{q}"
        raise ValueError(f"'{s}' is not a quarter; use 2026-Q3 for a quarterly file")
    m = re.fullmatch(r"(\d{4})(\.0)?", s)
    if m and 1900 <= int(m.group(1)) <= 2100:
        return m.group(1)
    raise ValueError(f"'{s}' is not a year; use 2026 for an annual file")


def parse_value(v) -> tuple[str | None, "Decimal | None", str | None]:
    """(raw_text, value, problem). Blank is missing, never zero. Text with thousands separators is refused, not guessed at."""
    if v is None:
        return None, None, None
    if isinstance(v, bool):
        return None, None, f"'{v}' is not a number"
    if isinstance(v, (int, float)):
        d = Decimal(str(v))
        if not d.is_finite():
            return None, None, "not a finite number"
        return format(d, "f"), d, None
    s = str(v).strip()
    if s.lower() in NULLS:
        return None, None, None
    if "," in s:
        return None, None, f"'{s}' has a comma; paste plain numbers with no thousands separators"
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None, None, f"'{s}' is not a number"
    if not d.is_finite():
        return None, None, f"'{s}' is not a finite number"
    return s, d, None


# ---------------------------------------------------------------------------------------------------------------
# Workbook
# ---------------------------------------------------------------------------------------------------------------

def _sheet(wb, name: str):
    for ws in wb.worksheets:
        if ws.title.strip().lower() == name:
            return ws
    return None


def _rows(ws):
    return [list(r) for r in ws.iter_rows(values_only=True)]


def parse_workbook(source, filename: str = "") -> FileParse:
    """source: a path or a file-like object. Returns a FileParse; any problem means the whole file is refused."""
    from openpyxl import load_workbook

    if isinstance(source, (str, Path)):
        raw = Path(source).read_bytes()
        filename = filename or Path(source).name
    else:
        raw = source.read()
        filename = filename or "upload.xlsx"
    fp = FileParse(filename=filename, sha256=hashlib.sha256(raw).hexdigest())
    try:
        wb = load_workbook(io.BytesIO(raw), data_only=True, read_only=False)
    except Exception as e:
        fp.problems.append(f"file: cannot be opened as an Excel workbook ({str(e)[:120]})")
        return fp
    src, ser, dat = _sheet(wb, "source"), _sheet(wb, "series"), _sheet(wb, "data")
    for nm, ws in (("Source", src), ("Series", ser), ("Data", dat)):
        if ws is None:
            fp.problems.append(f"file: the workbook has no sheet named {nm}")
    if fp.problems:
        return fp

    # example guard: a template with its illustration pasted in must never be loaded
    for ws in (src, ser, dat):
        for r in ws.iter_rows(values_only=True):
            if any(isinstance(c, str) and "EXAMPLE" in c.upper() for c in r):
                fp.problems.append(f"{ws.title}: contains the word EXAMPLE; remove the illustration before loading")
                break

    # ---- Source
    kv = {}
    for i, r in enumerate(_rows(src), start=1):
        if r and r[0] is not None and _text(r[0]) and i > 1:
            kv[_norm_key(r[0])] = (_text(r[1]) if len(r) > 1 else "", i)
    def need(k, label):
        if k not in kv or not kv[k][0]:
            fp.problems.append(f"Source: '{label}' is missing"); return ""
        return kv[k][0]
    iso = need("country_iso3", "country_iso3").upper()
    if iso and not re.fullmatch(r"[A-Z]{3}", iso):
        fp.problems.append(f"Source row {kv['country_iso3'][1]}: country_iso3 '{iso}' must be three capital letters")
    ccy = need("currency", "currency").upper()
    if ccy and not re.fullmatch(r"[A-Z]{3}", ccy):
        fp.problems.append(f"Source row {kv['currency'][1]}: currency '{ccy}' must be a three letter code such as KES")
    fp.country, fp.currency = iso, ccy
    fp.source_name = need("source_name", "source_name")[:200]
    fp.source_url = kv.get("source_url", ("", 0))[0][:400]
    fword = need("frequency", "frequency").upper()
    freq = FREQ_WORDS.get(fword, "")
    if fword and not freq:
        fp.problems.append(f"Source row {kv['frequency'][1]}: frequency '{fword}' must be M, Q or A (monthly, quarterly, annual)")
    fp.frequency = freq

    # ---- Series
    srows = _rows(ser)
    hdr = [_norm_key(c) for c in (srows[0] if srows else [])]
    cols = {"mnemonic", "sector_key", "sector_name", "role", "unit_label"}
    miss = sorted(cols - set(hdr))
    if miss:
        fp.problems.append(f"Series: missing column(s) {', '.join(miss)}")
    defs: dict[str, FileSeries] = {}
    if not miss:
        ix = {h: i for i, h in enumerate(hdr) if h}
        def g(row, k):
            return _text(row[ix[k]]) if k in ix and ix[k] < len(row) else ""
        seen_keys, totals = set(), 0
        for n, row in enumerate(srows[1:], start=2):
            if not any(_text(c) for c in row):
                continue
            mn, sk, sn, role = g(row, "mnemonic"), g(row, "sector_key"), g(row, "sector_name"), g(row, "role").lower()
            where = f"Series row {n}"
            if not re.fullmatch(r"[A-Za-z0-9_]{2,60}", mn):
                fp.problems.append(f"{where}: mnemonic '{mn}' must be 2 to 60 letters, digits or underscores"); continue
            if mn in defs:
                fp.problems.append(f"{where}: mnemonic {mn} appears twice"); continue
            if not re.fullmatch(r"[a-z0-9_]{2,60}", sk):
                fp.problems.append(f"{where}: sector_key '{sk}' must be lowercase letters, digits and underscores")
            if sk in seen_keys:
                fp.problems.append(f"{where}: sector_key {sk} is used by another series")
            seen_keys.add(sk)
            if not sn:
                fp.problems.append(f"{where}: sector_name is empty")
            if role not in ROLES:
                fp.problems.append(f"{where}: role '{role}' must be total or sector")
            totals += role == "total"
            ul = g(row, "unit_label")
            if not ul:
                fp.problems.append(f"{where}: unit_label is empty (for example KES Million)")
            mult_txt = g(row, "multiplier_to_millions")
            if mult_txt:
                try:
                    mult = float(mult_txt)
                    if not mult > 0:
                        raise ValueError
                except ValueError:
                    fp.problems.append(f"{where}: multiplier_to_millions '{mult_txt}' must be a positive number"); mult = 1.0
            elif re.search(r"million", ul, re.I) and not re.search(r"billion|thousand", ul, re.I):
                mult = 1.0
            elif ul:
                fp.problems.append(f"{where}: the unit '{ul}' is not millions, so multiplier_to_millions is required (1000 for billions, 0.001 for thousands, 0.000001 for whole units)"); mult = 1.0
            else:
                mult = 1.0
            kind = g(row, "measure_kind").lower()
            if kind and kind not in KINDS:
                fp.problems.append(f"{where}: measure_kind '{kind}' must be stock, flow, unverified or blank"); kind = ""
            defs[mn] = FileSeries(mn, sk, sn[:200], role, ul[:120], mult, kind, g(row, "definition_notes")[:2900])
        if not defs:
            fp.problems.append("Series: no series are listed")
        if totals > 1:
            fp.problems.append("Series: only one series may have the role total")
        if len(defs) > MAX_SERIES:
            fp.problems.append(f"Series: more than {MAX_SERIES} series")

    # ---- Data
    drows = _rows(dat)
    if not drows or not drows[0]:
        fp.problems.append("Data: the first row must hold 'period' and the series mnemonics")
        return fp
    head = [_text(c) for c in drows[0]]
    if _norm_key(head[0]) != "period":
        fp.problems.append(f"Data row 1: the first column must be 'period', found '{head[0]}'")
    cols_ix = {}
    for i, h in enumerate(head[1:], start=1):
        if not h:
            continue
        if h not in defs:
            fp.problems.append(f"Data row 1: column '{h}' is not a mnemonic on the Series sheet")
        elif h in cols_ix:
            fp.problems.append(f"Data row 1: column '{h}' appears twice")
        else:
            cols_ix[h] = i
    for mn in defs:
        if mn not in cols_ix:
            fp.problems.append(f"Data: no column for series {mn}")
    if len(drows) - 1 > MAX_ROWS:
        fp.problems.append(f"Data: more than {MAX_ROWS} rows")
    if fp.problems:
        return fp
    seen_p: dict[str, int] = {}
    today = date.today()
    for n, row in enumerate(drows[1:], start=2):
        if not any(c is not None and _text(c) for c in row):
            continue
        try:
            p = parse_period(row[0] if row else None, freq)
        except ValueError as e:
            fp.problems.append(f"Data row {n}: {e}"); continue
        if p in seen_p:
            fp.problems.append(f"Data row {n}: period {p} also appears on row {seen_p[p]}"); continue
        seen_p[p] = n
        if C.period_end(p) > today.isoformat():
            fp.problems.append(f"Data row {n}: period {p} has not ended yet"); continue
        for mn, i in cols_ix.items():
            cell = row[i] if i < len(row) else None
            raw, val, bad = parse_value(cell)
            if bad:
                fp.problems.append(f"Data row {n}, {mn}: {bad}"); continue
            if val is not None and val < 0 and defs[mn].measure_kind != "flow":
                fp.problems.append(f"Data row {n}, {mn}: {raw} is negative; a credit balance cannot be negative"); continue
            defs[mn].obs.append(C.Obs(p, _text(row[0]) if not isinstance(row[0], (datetime, date)) else p, raw, val))
        if len(fp.problems) >= 40:
            fp.problems.append("stopped after 40 problems"); break
    for d in defs.values():
        d.obs.sort(key=lambda o: o.period)
        if not any(o.value is not None for o in d.obs):
            fp.problems.append(f"Data: series {d.mnemonic} has no values at all")
    if fp.problems:
        return fp
    fp.series = list(defs.values())

    # ---- warnings (do not refuse the file)
    tot = next((s for s in fp.series if s.role == "total"), None)
    comps = [s for s in fp.series if s.role == "sector"]
    if tot and comps:
        add = C.additivity([(o.period, float(o.value)) for o in tot.obs if o.value is not None],
                           [[(o.period, float(o.value)) for o in c.obs if o.value is not None] for c in comps])
        if add["checked"] >= 3 and add["pct_ok"] is not None and add["pct_ok"] < 95:
            fp.warnings.append(f"The sectors add up to the total in only {add['pct_ok']}% of {add['checked']} periods. Shares and a total are shown only where they do add up.")
    elif comps and not tot:
        fp.warnings.append("No total series: sector shares and a total will not be shown.")
    last = {s.mnemonic: max((o.period for o in s.obs if o.value is not None), default=None) for s in fp.series}
    if len(set(last.values())) > 1:
        fp.warnings.append("Series end at different periods (" + ", ".join(f"{k} {v}" for k, v in sorted(last.items())[:6]) + "); rankings use the latest period every sector has.")
    for s in fp.series:
        z = C.zero_run_flag([(o.period, float(o.value)) for o in s.obs if o.value is not None])
        if z:
            fp.warnings.append(f"{s.mnemonic} is zero since {z['since']} after a long history; it is kept as given and flagged on the page.")
    if not any(s.measure_kind for s in fp.series):
        fp.warnings.append("measure_kind is blank, so the pipeline will infer stock or flow from behaviour and say 'inferred'. Fill it in if the central bank states what the series is.")
    return fp


# ---------------------------------------------------------------------------------------------------------------
# Template
# ---------------------------------------------------------------------------------------------------------------

def template_sheets(cfg: dict) -> list[dict]:
    """Template content from credit_config.json's file_format block, so the website and the pipeline give the same workbook."""
    ff = cfg["file_format"]
    ex = ff["example"]
    sheets = [
        {"name": "Source", "widths": [20, 60], "rows": [["field", "value"], *[[k, None] for k, _ in ff["source_fields"]]]},
        {"name": "Series", "widths": [18, 20, 36, 10, 20, 22, 14, 60], "rows": [[k for k, _ in ff["series_columns"]]]},
        {"name": "Data", "widths": [12], "rows": [["period"]]},
        {"name": "How to fill", "widths": [26, 120], "rows": [["Sheet / column", "What to enter"], *[["Source: " + k, v] for k, v in ff["source_fields"]],
            [None, None], *[["Series: " + k, v] for k, v in ff["series_columns"]], [None, None], ["Data: period", ff["period_help"]],
            ["Data: other columns", "One column per mnemonic from the Series sheet, headed with exactly the same mnemonic. Paste plain numbers. A blank cell means the central bank published nothing for that period (it is never read as zero)."],
            [None, None], *[["Rule", r] for r in ff["rules"]]]},
        {"name": "Example", "widths": [20, 20, 36, 10, 20, 22, 14],
         "rows": [["EXAMPLE ONLY: do not load. Layout of a filled workbook.", None, None, None, None, None, None],
                  ["Source sheet", None, None, None, None, None, None], *[[k, v, None, None, None, None, None] for k, v in ex["source"]],
                  [None] * 7, ["Series sheet", None, None, None, None, None, None], ex["series_header"] + [None] * (7 - len(ex["series_header"])),
                  *[r + [None] * (7 - len(r)) for r in ex["series"]], [None] * 7, ["Data sheet", None, None, None, None, None, None],
                  ["period", *ex["data_header"]] + [None] * (7 - 1 - len(ex["data_header"])), *[r + [None] * (7 - len(r)) for r in ex["data"]]]},
    ]
    return sheets


def write_template(path: str | Path, cfg: dict) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    wb.remove(wb.active)
    for sh in template_sheets(cfg):
        ws = wb.create_sheet(sh["name"][:31])
        for r in sh["rows"]:
            ws.append(r)
        for i, w in enumerate(sh["widths"], start=1):
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
        if sh["name"] != "Example":
            for c in ws[1]:
                c.font = Font(bold=True)
                c.fill = PatternFill("solid", fgColor="D9F2E3")
            ws.freeze_panes = "A2"
    wb.save(str(path))
    return Path(path)
