"""Bank data template and validator for Tereflow's Finance module (Phase 1 skeleton).

    python scripts/finance/bank_template.py make  [--out templates/bank_template.xlsx]
    python scripts/finance/bank_template.py check FILE.xlsx [--config templates/finance_config.json] [--report report.csv]

`make` writes the Excel template with a Data sheet, a Metrics sheet (the allowed codes, read from the config file)
and an Example sheet. `check` validates a filled file without touching any database: it prints every problem with
its row number, writes an optional CSV report, and exits 0 only if every row is valid. Loading into the database
is a later step and will reuse this validator. Nothing in here is hardcoded: allowed values come from the config.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "templates" / "finance_config.json"
PERIOD = re.compile(r"^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$")


def load_config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def make(cfg: dict, out: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(cfg["columns"])
    ms = wb.create_sheet("Metrics")
    ms.append(["metric_code", "label", "allowed units", "is a rate (needs rate_type)"])
    for code, m in cfg["metrics"].items():
        ms.append([code, m["label"], ", ".join(m["units"]), "yes" if m["rate"] else "no"])
    ms.append([])
    ms.append(["rate_type values", ", ".join(cfg["rate_types"])])
    ms.append(["period format", cfg["period_format"]])
    ex = wb.create_sheet("Example")
    ex.append(cfg["columns"])
    ex.append(["EXAMPLE_BANK", "GHA", "2025", "NPL_RATIO", 14.2, "percent", "", "Annual report 2025, p. 31", ""])
    ex.append(["EXAMPLE_BANK", "GHA", "2025-06", "LENDING_RATE", 28.5, "percent", "GHS", "Published rate card, June 2025", "indicative"])
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)


def _rows(path: Path):
    """Yields data rows as lists, from the Data sheet of an Excel file or from a CSV (as saved from that sheet)."""
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            yield from csv.reader(fh)
        return
    wb = load_workbook(path, read_only=True, data_only=True)
    if "Data" not in wb.sheetnames:
        raise ValueError("no sheet called Data")
    yield from wb["Data"].iter_rows(values_only=True)


def check(cfg: dict, path: Path) -> tuple[int, list[tuple[int, str, str]]]:
    try:
        rows = _rows(path)
    except ValueError as e:
        return 0, [(0, "sheet", str(e))]
    header = [str(h).strip() if h is not None else "" for h in next(rows, [])]
    problems: list[tuple[int, str, str]] = []
    missing = [c for c in cfg["columns"] if c not in header]
    if missing:
        return 0, [(1, "header", f"missing column(s): {', '.join(missing)}")]
    idx = {c: header.index(c) for c in cfg["columns"]}
    seen, n = set(), 0
    for r, row in enumerate(rows, start=2):
        if row is None or all(v in (None, "") for v in row):
            continue
        n += 1
        g = lambda c: (row[idx[c]] if idx[c] < len(row) else None)
        for c in cfg["required"]:
            if g(c) in (None, ""):
                problems.append((r, c, "required value is empty"))
        code, unit, iso = str(g("metric_code") or "").strip(), str(g("unit") or "").strip(), str(g("country_iso3") or "").strip()
        m = cfg["metrics"].get(code)
        if code and not m:
            problems.append((r, "metric_code", f"'{code}' is not an allowed metric (see Metrics sheet)"))
        if iso and not re.fullmatch(r"[A-Z]{3}", iso):
            problems.append((r, "country_iso3", f"'{iso}' must be three capital letters"))
        period = str(g("period") or "").strip()
        if period and not PERIOD.match(period):
            problems.append((r, "period", f"'{period}' is not a valid period ({cfg['period_format']})"))
        v = g("value")
        if v not in (None, ""):
            try:
                float(v)
            except (TypeError, ValueError):
                problems.append((r, "value", f"'{v}' is not a number"))
        if m and unit and unit not in m["units"]:
            problems.append((r, "unit", f"'{unit}' not allowed for {code}; use {', '.join(m['units'])}"))
        if m and unit == "currency" and not str(g("currency") or "").strip():
            problems.append((r, "currency", "currency code required when unit is currency"))
        rt = str(g("rate_type") or "").strip()
        if m and m["rate"] and rt not in cfg["rate_types"]:
            problems.append((r, "rate_type", f"rate rows need rate_type, one of: {', '.join(cfg['rate_types'])}"))
        if m and not m["rate"] and rt:
            problems.append((r, "rate_type", f"{code} is not a rate, leave rate_type empty"))
        key = (str(g("institution_code")), iso, period, code, rt)
        if key in seen:
            problems.append((r, "row", "duplicate of an earlier row (same institution, country, period, metric, rate type)"))
        seen.add(key)
    return n, problems


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("--out", default=str(ROOT / "templates" / "bank_template.xlsx"))
    m.add_argument("--config", default=str(DEFAULT_CONFIG))
    c = sub.add_parser("check")
    c.add_argument("file")
    c.add_argument("--config", default=str(DEFAULT_CONFIG))
    c.add_argument("--report", help="write the problems to this CSV file")
    a = p.parse_args(argv)
    cfg = load_config(Path(a.config))
    if a.cmd == "make":
        make(cfg, Path(a.out))
        print(f"wrote {a.out}")
        return 0
    n, problems = check(cfg, Path(a.file))
    print(f"{a.file}: {n} data row(s) read, {len(problems)} problem(s)")
    for r, col, msg in problems[:200]:
        print(f"  row {r} [{col}]: {msg}")
    if a.report:
        with open(a.report, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["row", "column", "problem"])
            w.writerows(problems)
    print("VALID" if not problems and n else "NOT VALID")
    return 0 if not problems and n else 1


if __name__ == "__main__":
    sys.exit(main())