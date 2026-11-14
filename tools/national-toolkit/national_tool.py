"""Tereflow National statistics toolkit: check a trade-series workbook and analyse it, on any PC.

    python national_tool.py template [--out tereflow-national-template.xlsx]
    python national_tool.py check    FILE.xlsx|FILE.csv --frequency monthly|quarterly|annual [--report problems.csv]
    python national_tool.py analyse  FILE.xlsx --frequency monthly|quarterly|annual [--out analysis]

analyse writes, per country and flow:
  totals.csv    the total for each period, change on the same period a year earlier, and the year-to-date growth
  products.csv  each product (HS code) latest period against the same period a year earlier, biggest movers first
  report.md     a plain-language summary
Only figures in the file are used. A change is shown only when the same period a year earlier is in the file.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "national_config.json").read_text(encoding="utf-8"))
PERIODS = {"monthly": re.compile(r"^\d{4}-(0[1-9]|1[0-2])$"), "quarterly": re.compile(r"^\d{4}-Q[1-4]$"), "annual": re.compile(r"^\d{4}$")}
HS = re.compile(r"^(TOTAL|\d{2}|\d{4}|\d{6})$")


def read(path: Path):
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            return [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in csv.DictReader(fh)]
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb["Data"] if "Data" in wb.sheetnames else wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    head = [str(h).strip() if h is not None else "" for h in next(it, [])]
    return [{h: ("" if v is None else str(v).strip()) for h, v in zip(head, r)} for r in it if r and any(v not in (None, "") for v in r)]


def validate(rows, freq):
    problems = []
    if rows:
        miss = [c for c in CFG["columns"] if c not in rows[0]]
        if miss:
            return [(1, "header", "missing column(s): " + ", ".join(miss))]
    seen = set()
    for i, r in enumerate(rows, start=2):
        for c in CFG["required"]:
            if not r.get(c):
                problems.append((i, c, "required value is empty"))
        if r.get("country_iso3") and not re.fullmatch(r"[A-Z]{3}", r["country_iso3"]):
            problems.append((i, "country_iso3", "must be three capital letters"))
        if r.get("flow") and r["flow"] not in CFG["flows"]:
            problems.append((i, "flow", "must be X (exports) or M (imports)"))
        if r.get("period") and not PERIODS[freq].match(r["period"]):
            problems.append((i, "period", f"'{r['period']}' does not match {freq}: {CFG['period_formats'][freq]}"))
        if r.get("hs_code") and not HS.match(r["hs_code"]):
            problems.append((i, "hs_code", "must be TOTAL or a 2, 4 or 6 digit HS code (keep leading zeros)"))
        if r.get("value_usd"):
            try:
                if float(r["value_usd"]) < 0:
                    problems.append((i, "value_usd", "must not be negative"))
            except ValueError:
                problems.append((i, "value_usd", f"'{r['value_usd']}' is not a number"))
        k = (r.get("country_iso3"), r.get("flow"), r.get("period"), r.get("hs_code"))
        if k in seen:
            problems.append((i, "row", "duplicate of an earlier row"))
        seen.add(k)
    return problems


def prev_year(p):
    return f"{int(p[:4]) - 1}{p[4:]}"


def pct(a, b):
    return round((a / b - 1) * 100, 1) if b else None


def write_csv(path, header, rows):
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)


def usd(v):
    return f"USD {v / 1e9:.2f}bn" if v >= 1e9 else f"USD {v / 1e6:.1f}m"


def cmd_analyse(path, freq, out):
    rows = read(path)
    problems = validate(rows, freq)
    if problems or not rows:
        print(f"The file has {len(problems)} problem(s); fix them first (run: national_tool.py check ...)")
        for r, c, m in problems[:20]:
            print(f"  row {r} [{c}]: {m}")
        return 1
    data = defaultdict(dict)
    for r in rows:
        data[(r["country_iso3"], r["flow"], r["hs_code"])][r["period"]] = float(r["value_usd"])
    out.mkdir(parents=True, exist_ok=True)
    for iso, flow in sorted({(k[0], k[1]) for k in data}):
        d = out / f"{iso}_{flow}"
        d.mkdir(parents=True, exist_ok=True)
        tot = data.get((iso, flow, "TOTAL"), {})
        trows = []
        for p in sorted(tot):
            py = tot.get(prev_year(p))
            trows.append([p, tot[p], "" if py is None else pct(tot[p], py)])
        write_csv(d / "totals.csv", ["period", "value_usd", "change_vs_same_period_last_year_pct"], trows)
        lines = [f"# {iso} {CFG['flows'][flow]}", ""]
        if tot:
            last = max(tot)
            py = tot.get(prev_year(last))
            lines.append(f"Latest period in the file: {last}, {usd(tot[last])}" + (f", {pct(tot[last], py):+.1f}% on {prev_year(last)}." if py else ", with no figure a year earlier to compare."))
            if freq == "monthly":
                yr = last[:4]
                ytd = sum(v for p, v in tot.items() if p[:4] == yr)
                ytd_py = sum(tot[prev_year(p)] for p in tot if p[:4] == yr and prev_year(p) in tot)
                n = sum(1 for p in tot if p[:4] == yr and prev_year(p) in tot)
                if n and n == sum(1 for p in tot if p[:4] == yr):
                    lines.append(f"Year to date {yr}: {usd(ytd)}, {pct(ytd, ytd_py):+.1f}% on the same months of {int(yr) - 1}.")
        prod = []
        for (c, f, hs), series in data.items():
            if c != iso or f != flow or hs == "TOTAL" or not series:
                continue
            last = max(series)
            py = series.get(prev_year(last))
            prod.append([hs, last, series[last], "" if py is None else py, "" if py is None else pct(series[last], py), "" if py is None else series[last] - py])
        prod.sort(key=lambda x: -abs(x[5]) if x[5] != "" else 0)
        write_csv(d / "products.csv", ["hs_code", "latest_period", "value_usd", "same_period_last_year_usd", "change_pct", "change_usd"], prod)
        movers = [x for x in prod if x[5] != ""][:5]
        if movers:
            lines += ["", "Biggest movers (value change on the same period a year earlier):"]
            lines += [f"- HS {x[0]} ({x[1]}): {usd(x[2])}, {x[4]:+.1f}%" for x in movers]
        (d / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"{iso} {flow}: wrote totals, products and report to {d}")
    return 0


def cmd_check(path, freq, report):
    rows = read(path)
    problems = validate(rows, freq)
    print(f"{path.name}: {len(rows)} data row(s), {len(problems)} problem(s)")
    for r, c, m in problems[:200]:
        print(f"  row {r} [{c}]: {m}")
    if report:
        write_csv(Path(report), ["row", "column", "problem"], problems)
    print("VALID" if rows and not problems else "NOT VALID")
    return 0 if rows and not problems else 1


def cmd_template(out):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(CFG["columns"])
    ex = wb.create_sheet("How to fill")
    for line in ["One row per country, flow, period and product.", "flow: X = exports, M = imports.", "period: " + "; ".join(f"{k}: {v}" for k, v in CFG["period_formats"].items()), "hs_code: " + CFG["hs_code"], "value_usd: whole US dollars, numbers only.", "source_note: where the figure was published (table, page or release name)."]:
        ex.append([line])
    wb.save(out)
    print("wrote", out)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("template"); t.add_argument("--out", default="tereflow-national-template.xlsx")
    for n in ("check", "analyse"):
        s = sub.add_parser(n); s.add_argument("file"); s.add_argument("--frequency", required=True, choices=list(PERIODS))
        if n == "check":
            s.add_argument("--report")
        else:
            s.add_argument("--out", default="analysis")
    x = p.parse_args(argv)
    if x.cmd == "template":
        cmd_template(Path(x.out))
        return 0
    if x.cmd == "check":
        return cmd_check(Path(x.file), x.frequency, x.report)
    return cmd_analyse(Path(x.file), x.frequency, Path(x.out))


if __name__ == "__main__":
    sys.exit(main())
