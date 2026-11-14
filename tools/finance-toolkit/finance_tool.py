"""Tereflow Finance toolkit: check a bank-figures workbook and run the same analysis the website shows, on any PC.

    python finance_tool.py template [--out tereflow-finance-template.xlsx]
    python finance_tool.py check    FILE.xlsx|FILE.csv [--report problems.csv]
    python finance_tool.py analyse  FILE.xlsx [--out analysis] [--country GHA]

`check` validates every row against finance_config.json (allowed metrics, units, rate types, periods) and lists every
problem by row; it exits 0 only if the whole file is valid. `analyse` runs check first, then writes into the output folder:
  scorecard.csv   who leads on each measure for the latest year
  trends.csv      each bank's figures by year, with year-on-year change
  rates.csv       deposit, savings and Treasury bill rates, and published fees
  banks.csv       banks side by side, latest figure for each measure
  report.md       the same plain-language insight the website gives
The Data sheet is read. If the workbook also has an Institutions sheet (institution_code, name, country_iso3, kind) it is used
for names and to tell banks from the central bank and sector totals; otherwise every institution is treated as a bank.
Nothing is estimated: a measure is only shown where the file holds the figures to calculate it.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "finance_config.json").read_text(encoding="utf-8"))
PERIOD = re.compile(r"^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$")
ANNUAL = re.compile(r"^\d{4}$")


def read_workbook(path: Path):
    """Returns (data rows as dicts, institutions as {code: {name, kind, country}})."""
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            rows = [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in csv.DictReader(fh)]
        return rows, {}
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    if "Data" not in wb.sheetnames:
        raise SystemExit("The workbook has no sheet called Data")
    it = wb["Data"].iter_rows(values_only=True)
    head = [str(h).strip() if h is not None else "" for h in next(it, [])]
    rows = [{h: ("" if v is None else str(v).strip()) for h, v in zip(head, r)} for r in it if r and any(v not in (None, "") for v in r)]
    inst = {}
    if "Institutions" in wb.sheetnames:
        ii = wb["Institutions"].iter_rows(values_only=True)
        ih = [str(h).strip() if h is not None else "" for h in next(ii, [])]
        for r in ii:
            d = dict(zip(ih, r))
            if d.get("institution_code"):
                inst[str(d["institution_code"]).strip()] = {"name": d.get("name") or d["institution_code"], "kind": d.get("kind") or "bank", "country": d.get("country_iso3") or ""}
    return rows, inst


def validate(rows):
    problems = []
    if rows:
        missing = [c for c in CFG["columns"] if c not in rows[0]]
        if missing:
            return [(1, "header", "missing column(s): " + ", ".join(missing))]
    seen = set()
    for i, r in enumerate(rows, start=2):
        for c in CFG["required"]:
            if not r.get(c):
                problems.append((i, c, "required value is empty"))
        code, unit, iso, period, rt = r.get("metric_code", ""), r.get("unit", ""), r.get("country_iso3", ""), r.get("period", ""), r.get("rate_type", "")
        m = CFG["metrics"].get(code)
        if code and not m:
            problems.append((i, "metric_code", f"'{code}' is not an allowed metric"))
        if iso and not re.fullmatch(r"[A-Z]{3}", iso):
            problems.append((i, "country_iso3", f"'{iso}' must be three capital letters"))
        if period and not PERIOD.match(period):
            problems.append((i, "period", f"'{period}' is not a valid period (YYYY, YYYY-MM or YYYY-Qn)"))
        if r.get("value", ""):
            try:
                float(r["value"])
            except ValueError:
                problems.append((i, "value", f"'{r['value']}' is not a number"))
        if m and unit and unit not in m["units"]:
            problems.append((i, "unit", f"'{unit}' not allowed for {code}; use {', '.join(m['units'])}"))
        if m and unit == "currency" and not r.get("currency"):
            problems.append((i, "currency", "currency code required when unit is currency"))
        if m and m["rate"] and rt not in CFG["rate_types"]:
            problems.append((i, "rate_type", "rate rows need rate_type, one of: " + ", ".join(CFG["rate_types"])))
        if m and not m["rate"] and rt:
            problems.append((i, "rate_type", f"{code} is not a rate, leave rate_type empty"))
        key = (r.get("institution_code"), iso, period, code, rt)
        if key in seen:
            problems.append((i, "row", "duplicate of an earlier row"))
        seen.add(key)
    return problems


def bn(v):
    return f"{v / 1e9:.1f}bn"


def analyse(rows, inst, country):
    rows = [r for r in rows if r["country_iso3"] == country]
    kind = lambda c: inst.get(c, {}).get("kind", "bank")
    name = lambda c: inst.get(c, {}).get("name", c)
    label = lambda m: CFG["metrics"][m]["label"]
    codes = {r["institution_code"] for r in rows}
    banks = sorted((c for c in codes if kind(c) == "bank"), key=name)
    sector = next((c for c in codes if kind(c) == "sector"), None)
    central = next((c for c in codes if kind(c) == "central_bank"), None)

    def val(c, m, per):
        for r in rows:
            if r["institution_code"] == c and r["metric_code"] == m and r["period"] == per:
                return float(r["value"])
        return None

    def latest(c, m):
        rr = sorted((r for r in rows if r["institution_code"] == c and r["metric_code"] == m), key=lambda r: r["period"], reverse=True)
        return (float(rr[0]["value"]), rr[0]["period"]) if rr else (None, None)

    years = sorted({r["period"] for r in rows if ANNUAL.match(r["period"]) and r["metric_code"] == "TOTAL_ASSETS" and r["institution_code"] in banks})
    yr = years[-1] if years else None
    prior = str(int(yr) - 1) if yr else None

    trends = []
    for m in ["TOTAL_ASSETS", "TOTAL_DEPOSITS", "TOTAL_LOANS", "CASH_BALANCE", "INVESTMENT_SECURITIES", "TOTAL_LIABILITIES", "TOTAL_EQUITY", "OPERATING_INCOME", "PROFIT_BEFORE_TAX", "PROFIT_AFTER_TAX"]:
        for b in banks:
            pts = sorted((r for r in rows if r["institution_code"] == b and r["metric_code"] == m and ANNUAL.match(r["period"])), key=lambda r: r["period"])
            for i, r in enumerate(pts):
                ch = round((float(r["value"]) / float(pts[i - 1]["value"]) - 1) * 100, 1) if i and float(pts[i - 1]["value"]) > 0 else ""
                trends.append([label(m), name(b), r["period"], float(r["value"]), ch, r["source_note"]])

    score = []
    if yr:
        v = val
        gp = lambda b, m: (v(b, m, yr) / v(b, m, prior) - 1) * 100 if v(b, m, yr) is not None and v(b, m, prior) else None
        ratio = lambda b, a, z: (v(b, a, yr) / v(b, z, yr)) * 100 if v(b, a, yr) is not None and v(b, z, yr) else None
        measures = [
            ("Deposits held", "higher", lambda b: v(b, "TOTAL_DEPOSITS", yr), lambda x: bn(x)),
            ("Deposit growth", "higher", lambda b: gp(b, "TOTAL_DEPOSITS"), lambda x: f"{x:.0f}%"),
            ("Cash on hand (share of assets)", "higher", lambda b: ratio(b, "CASH_BALANCE", "TOTAL_ASSETS"), lambda x: f"{x:.0f}%"),
            ("Profit growth", "higher", lambda b: gp(b, "PROFIT_AFTER_TAX"), lambda x: f"{x:.0f}%"),
            ("Profit on each unit of income", "higher", lambda b: ratio(b, "PROFIT_BEFORE_TAX", "OPERATING_INCOME"), lambda x: f"{x:.0f}%"),
            ("Own money behind the balance sheet", "higher", lambda b: ratio(b, "TOTAL_EQUITY", "TOTAL_ASSETS"), lambda x: f"{x:.1f}%"),
            ("Capital adequacy", "higher", lambda b: v(b, "CAPITAL_ADEQUACY", yr), lambda x: f"{x:.2f}%"),
            ("Loan quality (lower is better)", "lower", lambda b: v(b, "NPL_RATIO", yr), lambda x: f"{x:.2f}%"),
            ("Interest paid on deposits", "higher", lambda b: v(b, "DEPOSIT_RATE_AVG", yr), lambda x: f"{x:.2f}%"),
        ]
        for title, better, f, fmt in measures:
            vals = [(b, f(b)) for b in banks if f(b) is not None]
            if len(vals) < 2:
                continue
            vals.sort(key=lambda t: t[1], reverse=(better == "higher"))
            score.append([title, yr] + [x for b, x_ in vals for x in (name(b), fmt(x_))])

    rates = []
    for r in rows:
        if CFG["metrics"][r["metric_code"]]["rate"]:
            rates.append([name(r["institution_code"]), label(r["metric_code"]), r["period"], float(r["value"]), r.get("rate_type", ""), r["source_note"]])
    rates.sort(key=lambda x: (x[0], x[1], x[2]))

    table = []
    for m in ["TOTAL_ASSETS", "CASH_BALANCE", "INVESTMENT_SECURITIES", "TOTAL_LOANS", "TOTAL_DEPOSITS", "TOTAL_LIABILITIES", "TOTAL_EQUITY", "OPERATING_INCOME", "PROFIT_BEFORE_TAX", "PROFIT_AFTER_TAX", "CAPITAL_ADEQUACY", "NPL_RATIO", "RETURN_ON_EQUITY", "COST_TO_INCOME", "BRANCH_COUNT", "DEPOSIT_RATE_AVG"]:
        cells = []
        for b in banks:
            x, p = latest(b, m)
            cells.append("not held" if x is None else f"{x:,.2f}".rstrip("0").rstrip(".") + f" ({p})")
        if any(c != "not held" for c in cells):
            table.append([label(m)] + cells)

    L = [f"# Bank intelligence: {country}", "", f"Latest annual year compared: {yr or 'none'}. Every figure comes from the file you supplied; nothing is estimated.", ""]
    if score:
        L += ["## Who is doing well", ""]
        tally = {}
        for row in score:
            tally.setdefault(row[2], []).append(row[0].split(" (")[0].lower())
        L.append("; ".join(f"{b} leads on {len(ms)} ({', '.join(ms)})" for b, ms in sorted(tally.items(), key=lambda t: -len(t[1]))) + ". No bank leads on everything, so the right choice depends on what you need.")
        L.append("")
        for row in score:
            L.append(f"- **{row[0]}**: " + " | ".join(f"{row[i]} {row[i + 1]}" for i in range(2, len(row), 2)))
        L.append("")
    if yr and banks:
        big = max(banks, key=lambda b: val(b, "TOTAL_ASSETS", yr) or 0)
        if val(big, "TOTAL_ASSETS", yr):
            sec = (val(sector, "TOTAL_ASSETS", yr) or val(sector, "TOTAL_ASSETS", yr + "-12")) if sector else None
            L += ["## Size", "", f"{name(big)} holds the most assets of the banks listed, at {bn(val(big, 'TOTAL_ASSETS', yr))}" + (f", about {val(big, 'TOTAL_ASSETS', yr) / sec * 100:.0f}% of the whole banking sector." if sec else "."), ""]
    if central:
        pol, pp = latest(central, "POLICY_RATE")
        if pol is not None:
            L += ["## Cost of borrowing and saving", "", f"Central bank policy rate: {pol}% ({pp})."]
            for m in ("TBILL_91D", "TBILL_364D"):
                x, p = latest(central, m)
                if x is not None:
                    L.append(f"{label(m)}: {x}% ({p}).")
            if sector:
                for m in ("LENDING_RATE", "REFERENCE_RATE", "SAVINGS_RATE", "DEPOSIT_RATE"):
                    if m in CFG["metrics"]:
                        x, p = latest(sector, m)
                        if x is not None:
                            L.append(f"Sector average, {label(m).lower()}: {x}% ({p}).")
            L.append("")
    L += ["## Where every figure comes from", "", "Each row of trends.csv, rates.csv and banks.csv carries its source note from your file.", ""]
    return {"scorecard": score, "trends": trends, "rates": rates, "banks": [["Figure"] + [name(b) for b in banks]] + table, "report": "\n".join(L)}


def write_csv(path, header, rows):
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        if header:
            w.writerow(header)
        w.writerows(rows)


def cmd_template(out):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(CFG["columns"])
    ms = wb.create_sheet("Metrics")
    ms.append(["metric_code", "label", "allowed units", "is a rate (needs rate_type)", "ranking"])
    for code, m in CFG["metrics"].items():
        ms.append([code, m["label"], ", ".join(m["units"]), "yes" if m["rate"] else "no", {"higher": "higher ranks first", "lower": "lower ranks first"}.get(m.get("better"), "not ranked")])
    ins = wb.create_sheet("Institutions")
    ins.append(["institution_code", "name", "country_iso3", "kind"])
    ins.append(["EXAMPLE_BANK", "Example Bank", "GHA", "bank"])
    ins.append(["EXAMPLE_CENTRAL_BANK", "Example Central Bank", "GHA", "central_bank"])
    ins.append(["EXAMPLE_SECTOR", "Banking sector (aggregate)", "GHA", "sector"])
    ex = wb.create_sheet("Example")
    ex.append(CFG["columns"])
    ex.append(["EXAMPLE_BANK", "GHA", "2025", "TOTAL_ASSETS", 31529847000, "currency", "GHS", "EXAMPLE ONLY: annual report 2025, statement of financial position", ""])
    ex.append(["EXAMPLE_BANK", "GHA", "2025", "NPL_RATIO", 17, "percent", "", "EXAMPLE ONLY: annual report 2025", ""])
    wb.save(out)
    print("wrote", out)


def cmd_check(path, report=None):
    rows, _ = read_workbook(path)
    problems = validate(rows)
    print(f"{path.name}: {len(rows)} data row(s), {len(problems)} problem(s)")
    for r, c, m in problems[:200]:
        print(f"  row {r} [{c}]: {m}")
    if report:
        write_csv(Path(report), ["row", "column", "problem"], problems)
    print("VALID" if rows and not problems else "NOT VALID")
    return 0 if rows and not problems else 1


def cmd_analyse(path, out, country):
    rows, inst = read_workbook(path)
    problems = validate(rows)
    if problems or not rows:
        print(f"The file has {len(problems)} problem(s); fix them first (run: finance_tool.py check {path.name})")
        for r, c, m in problems[:20]:
            print(f"  row {r} [{c}]: {m}")
        return 1
    out.mkdir(parents=True, exist_ok=True)
    for c in [country] if country else sorted({r["country_iso3"] for r in rows}):
        res = analyse(rows, inst, c)
        d = out / c
        d.mkdir(parents=True, exist_ok=True)
        n = max((len(x) for x in res["scorecard"]), default=2)
        write_csv(d / "scorecard.csv", ["measure", "year"] + sum([[f"rank{i}_bank", f"rank{i}_value"] for i in range(1, (n - 2) // 2 + 1)], []), res["scorecard"])
        write_csv(d / "trends.csv", ["measure", "bank", "year", "value", "change_vs_previous_year_pct", "source_note"], res["trends"])
        write_csv(d / "rates.csv", ["institution", "rate", "period", "value_pct", "rate_type", "source_note"], res["rates"])
        write_csv(d / "banks.csv", None, res["banks"])
        (d / "report.md").write_text(res["report"], encoding="utf-8")
        print(f"{c}: wrote scorecard, trends, rates, banks and report to {d}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("template"); t.add_argument("--out", default="tereflow-finance-template.xlsx")
    c = sub.add_parser("check"); c.add_argument("file"); c.add_argument("--report")
    a = sub.add_parser("analyse"); a.add_argument("file"); a.add_argument("--out", default="analysis"); a.add_argument("--country")
    x = p.parse_args(argv)
    if x.cmd == "template":
        cmd_template(Path(x.out))
        return 0
    if x.cmd == "check":
        return cmd_check(Path(x.file), x.report)
    return cmd_analyse(Path(x.file), Path(x.out), x.country.upper() if x.country else None)


if __name__ == "__main__":
    sys.exit(main())
