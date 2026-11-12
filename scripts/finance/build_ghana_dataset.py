"""Builds templates/examples/GHA_published_figures_2026-11.xlsx from figures read on 12 Nov 2026 in documents published by
the banks and by the Bank of Ghana. Every row names the document it came from. Nothing here is estimated: where a document
did not state a figure, there is no row. Money in the source is in GHS thousands and is converted to full cedis here.

    python scripts/finance/build_ghana_dataset.py
    python scripts/finance/bank_template.py check templates/examples/GHA_published_figures_2026-11.xlsx
    python scripts/finance/bank_load.py load templates/examples/GHA_published_figures_2026-11.xlsx --replace
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
CFG = json.loads((ROOT / "templates" / "finance_config.json").read_text(encoding="utf-8"))
OUT = ROOT / "templates" / "examples" / "GHA_published_figures_2026-11.xlsx"
K = 1000  # the source statements are in GHS thousands

INSTITUTIONS = [
    ("STANCHART_GH", "Standard Chartered Bank Ghana PLC", "bank", "https://www.sc.com/gh/"),
    ("ABSA_GH", "Absa Bank Ghana Limited", "bank", "https://www.absa.com.gh/"),
    ("GCB_BANK", "GCB Bank PLC", "bank", "https://www.gcbbank.com.gh/"),
    ("FIDELITY_GH", "Fidelity Bank Ghana Limited", "bank", "https://www.fidelitybank.com.gh/"),
    ("BANK_OF_GHANA", "Bank of Ghana", "central_bank", "https://www.bog.gov.gh/"),
    ("GH_BANKING_SECTOR", "Ghana banking sector (all banks, aggregate)", "sector", "https://www.bog.gov.gh/"),
]

SC25 = "Standard Chartered Bank Ghana PLC, Annual Report 2025 (https://av.sc.com/gh/content/docs/gh-scb-annual-report-2025.pdf)"
AB25 = "Absa Bank Ghana Ltd, Annual Report 2025 (https://www.absa.com.gh/content/dam/ghana/absa/pdf/annual-reports/financial-statement-2025.pdf)"
GC25 = "GCB Bank PLC, Summary separate and consolidated financial statements, year ended 31 Dec 2025 (https://www.gcbbank.com.gh/group-results-and-reporting/460-2025-audited-financial-statements/file)"
BOG = "Bank of Ghana, Summary of Economic and Financial Data, release 23 Sep 2026 (https://www.bog.gov.gh/wp-content/uploads/2026/09/Summary-of-Economic-and-Financial-Data-September-2026.pdf)"

rows: list[list] = []


def add(inst, period, metric, value, unit, source, currency=None, rate_type=None):
    assert metric in CFG["metrics"], metric
    assert unit in CFG["metrics"][metric]["units"], (metric, unit)
    rows.append([inst, "GHA", period, metric, value, unit, currency, source, rate_type])


def money(inst, period, metric, thousands, source):
    add(inst, period, metric, thousands * K, "currency", source, currency="GHS")


# ---- Standard Chartered Bank Ghana (Group figures; statement of financial position and profit or loss) ----
for per, a, l, d, p in (("2025", 16506032, 1887422, 12367687, 804207), ("2024", 14303463, 2305886, 11308032, 716148)):
    s = f"{SC25}: consolidated statement of financial position and statement of profit or loss, Group column, FY{per}"
    money("STANCHART_GH", per, "TOTAL_ASSETS", a, s)
    money("STANCHART_GH", per, "TOTAL_LOANS", l, s + " (loans and advances to customers)")
    money("STANCHART_GH", per, "TOTAL_DEPOSITS", d, s + " (deposits from customers)")
    money("STANCHART_GH", per, "PROFIT_AFTER_TAX", p, s + " (profit for the year)")
cfo = f"{SC25}: Chief Finance Officer's review, p.24"
add("STANCHART_GH", "2025", "CAPITAL_ADEQUACY", 27.45, "percent", cfo)
add("STANCHART_GH", "2024", "CAPITAL_ADEQUACY", 24.01, "percent", cfo)
add("STANCHART_GH", "2025", "NPL_RATIO", 25.82, "percent", cfo + " (gross NPL ratio; the bank also states 0.81% less loss category)")
add("STANCHART_GH", "2024", "NPL_RATIO", 24.77, "percent", cfo + " (gross NPL ratio; the bank also states 1.75% less loss category)")
add("STANCHART_GH", "2025", "BRANCH_COUNT", 18, "count", f"{SC25}: notes to the financial statements, 'a limited liability company with 18 branches'")

# ---- Absa Bank Ghana (statement of financial position p.69; performance highlights in the Managing Director's report) ----
for per, a, l, d, p in (("2025", 31529847, 9995251, 19185669, 1762411), ("2024", 27341756, 8344900, 17631015, 1194729)):
    s = f"{AB25}: statement of financial position p.69 and statement of comprehensive income, FY{per}"
    money("ABSA_GH", per, "TOTAL_ASSETS", a, s)
    money("ABSA_GH", per, "TOTAL_LOANS", l, s + " (loans and advances to customers)")
    money("ABSA_GH", per, "TOTAL_DEPOSITS", d, s + " (deposits from customers)")
    money("ABSA_GH", per, "PROFIT_AFTER_TAX", p, s + " (profit for the year)")
hl = f"{AB25}: Managing Director's report, 2025 performance highlights"
add("ABSA_GH", "2025", "RETURN_ON_EQUITY", 34.7, "percent", hl)
add("ABSA_GH", "2025", "RETURN_ON_ASSETS", 5.99, "percent", hl + " (return on average assets, as stated by the bank)")
add("ABSA_GH", "2025", "COST_TO_INCOME", 37, "percent", hl + " (stated as 37%)")
add("ABSA_GH", "2025", "NPL_RATIO", 17, "percent", hl + " (stated as 17%, against 15.5% the year before)")
add("ABSA_GH", "2024", "NPL_RATIO", 15.5, "percent", hl + " (prior-year comparative)")
add("ABSA_GH", "2025", "CAPITAL_ADEQUACY", 25, "percent", f"{AB25}: Finance Director's performance review, 'closed, post capitalisation of the 2025 profits, at 25%' (stated to the nearest whole percent)")
add("ABSA_GH", "2026-11", "REFERENCE_RATE", 10.01, "percent", "Absa Bank Ghana, published Ghana Reference Rate, effective 4 November 2026 (https://www.absa.com.gh/content/dam/ghana/absa/pdf/base-rate/ghana-reference-rate.pdf)", rate_type="variable")

# ---- GCB Bank (Group columns of the summary statements; ratios from its Quantitative Disclosures) ----
for per, a, l, d, p in (("2025", 52633491, 16038002, 41042734, 2060740), ("2024", 42796072, 10229504, 33970718, 1200872)):
    s = f"{GC25}: statement of financial position and profit or loss, Group column, FY{per}"
    money("GCB_BANK", per, "TOTAL_ASSETS", a, s)
    money("GCB_BANK", per, "TOTAL_LOANS", l, s + " (loans and advances to customers)")
    money("GCB_BANK", per, "TOTAL_DEPOSITS", d, s + " (deposits from customers)")
    money("GCB_BANK", per, "PROFIT_AFTER_TAX", p, s + " (profit for the year)")
qd = f"{GC25}: Quantitative Disclosures"
add("GCB_BANK", "2025", "CAPITAL_ADEQUACY", 18.02, "percent", qd + " (capital adequacy ratio, CRD basis)")
add("GCB_BANK", "2024", "CAPITAL_ADEQUACY", 17.47, "percent", qd + " (capital adequacy ratio, CRD basis)")
add("GCB_BANK", "2025", "NPL_RATIO", 10.31, "percent", qd + " (non-performing loans ratio; 1.52% less loss category)")
add("GCB_BANK", "2024", "NPL_RATIO", 15.06, "percent", qd + " (non-performing loans ratio; 1.80% less loss category)")

# ---- Fidelity Bank Ghana: published trade services tariff ----
fb = "Fidelity Bank Ghana, Tariff Guide August 2026, Trade Services (https://fidelitybank.com.gh/wp-content/uploads/2026/08/FB_Tariff_Guide_August_2026.pdf)"
for metric, v, text in (
    ("FEE_LC_IMPORT_SIGHT", 1.0, "Documentary Letters of Credit - Imports, Establishment (Sight): 1% per quarter, minimum US$200"),
    ("FEE_LC_IMPORT_USANCE", 1.5, "Documentary Letters of Credit - Imports, Establishment (Usance): 1.5% per quarter"),
    ("FEE_LC_EXPORT_NEGOTIATION", 1.0, "Documentary Letters of Credit - Exports, Negotiation (Credit): 1%, minimum US$200"),
    ("FEE_GUARANTEE_PERIODIC", 1.0, "Guarantees / Bonds, Periodic Charge: 1% per quarter"),
    ("FEE_COLLECTION_EXPORT", 0.5, "Outward Bills for Collection - Export, Handling Commission: 0.50%, minimum US$50, maximum US$100"),
):
    add("FIDELITY_GH", "2026-08", metric, v, "percent", f"{fb}: {text}", rate_type="fixed")

# ---- Bank of Ghana: policy rate and sector aggregates ----
add("BANK_OF_GHANA", "2026-09", "POLICY_RATE", 14.0, "percent", "Bank of Ghana, Policy Rate Trends, MPC meeting 132 (23-24 Sep 2026), effective 24 Sep 2026 (https://www.bog.gov.gh/monetary-policy/policy-rate-trends/)", rate_type="policy")
add("BANK_OF_GHANA", "2025-12", "POLICY_RATE", 18.0, "percent", BOG + ": 3a Interest Rates, Monetary Policy Rate, 2025:12", rate_type="policy")
sec = {  # (period column in the BoG table) -> values, from sections 3a and 9 of the same release
    "2026-08": dict(assets=500.2, deposits=362.2, advances=129.2, car=19.1, npl=15.7, roa=4.3, roe=22.2, cti=74.7, lend=15.94, ref=10.61, dep3m=8.68),
    "2025-12": dict(assets=446.9, deposits=325.3, advances=111.0, car=17.5, npl=18.9, roa=5.7, roe=30.8, cti=74.3, lend=20.45, ref=15.90, dep3m=10.50),
}
for per, v in sec.items():
    s9 = f"{BOG}: 9. Banking Sector Indicators, column {per[:4]}:{per[5:]}"
    s3 = f"{BOG}: 3a. Interest Rates, column {per[:4]}:{per[5:]}"
    money("GH_BANKING_SECTOR", per, "TOTAL_ASSETS", round(v["assets"] * 1e6), s9 + " (total assets, GHS billion)")
    money("GH_BANKING_SECTOR", per, "TOTAL_DEPOSITS", round(v["deposits"] * 1e6), s9 + " (total deposits, GHS billion)")
    money("GH_BANKING_SECTOR", per, "TOTAL_LOANS", round(v["advances"] * 1e6), s9 + " (total advances, GHS billion)")
    add("GH_BANKING_SECTOR", per, "CAPITAL_ADEQUACY", v["car"], "percent", s9)
    add("GH_BANKING_SECTOR", per, "NPL_RATIO", v["npl"], "percent", s9 + " (non-performing loans)")
    add("GH_BANKING_SECTOR", per, "RETURN_ON_ASSETS", v["roa"], "percent", s9 + " (return on assets before tax)")
    add("GH_BANKING_SECTOR", per, "RETURN_ON_EQUITY", v["roe"], "percent", s9 + " (return on equity after tax)")
    add("GH_BANKING_SECTOR", per, "COST_TO_INCOME", v["cti"], "percent", s9 + " (total cost to gross income)")
    add("GH_BANKING_SECTOR", per, "LENDING_RATE", v["lend"], "percent", s3 + " (average lending rate)", rate_type="indicative")
    add("GH_BANKING_SECTOR", per, "REFERENCE_RATE", v["ref"], "percent", s3 + " (Ghana Reference Rate, base rate for pricing loans)", rate_type="indicative")
    add("GH_BANKING_SECTOR", per, "DEPOSIT_RATE", v["dep3m"], "percent", s3 + " (3-month time deposits)", rate_type="indicative")

wb = Workbook()
ws = wb.active
ws.title = "Data"
ws.append(CFG["columns"])
for r in rows:
    ws.append(r)
inst = wb.create_sheet("Institutions")
inst.append(["institution_code", "name", "country_iso3", "kind", "website"])
for c, n, k, w in INSTITUTIONS:
    inst.append([c, n, "GHA", k, w])
OUT.parent.mkdir(parents=True, exist_ok=True)
wb.save(OUT)
print(f"wrote {OUT} with {len(rows)} rows for {len({r[0] for r in rows})} institutions")
