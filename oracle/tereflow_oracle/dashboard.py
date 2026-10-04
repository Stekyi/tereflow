"""Country dashboard figures computed from Oracle trade facts.

A port of the trade-derived parts of worker/agent/analyse.ts (overview, ranked products,
ranked partners, yearly trend). Constants match the D1 defaults in worker/lib/settings.ts.
Anything that is not derived from trade facts (services, market context, recommendations,
momentum signals) stays in D1.

Totals: the ingestion stores Comtrade's per-product World row (partner WLD) and the
per-partner rows. A product's total is its World row, falling back to the sum of its partner
rows when there is none. A country's total is the sum over products, which reconciles to
Comtrade's own World rows (see v_world_reconciliation).
"""
from __future__ import annotations
import json
import math
from datetime import datetime, timezone

from .opportunity import NAMES

RANKED_TOP_N = 12
NOISE_FLOOR_SPECIFIC_USD = 2_000_000   # settings.noiseFloorHs6Usd
NOISE_FLOOR_CHAPTER_USD = 5_000_000    # settings.noiseFloorHs2Usd
GROWTH_BASE_DIVISOR = 20
FLOW_NAME = {"X": "export", "M": "import"}

PRODUCT_TOTALS_SQL = """
SELECT flow, year, cmd_code, MAX(cmd_desc) AS cmd_desc, MAX(classification_level) AS lvl,
       NVL(MAX(CASE WHEN partner_iso3 = 'WLD' THEN value_usd END),
           SUM(CASE WHEN partner_iso3 <> 'WLD' THEN value_usd END)) AS v
FROM tf_trade_facts WHERE reporter_iso3 = :rep
GROUP BY flow, year, cmd_code
"""
PARTNER_TOTALS_SQL = """
SELECT flow, year, partner_iso3, SUM(value_usd) AS v
FROM tf_trade_facts WHERE reporter_iso3 = :rep AND partner_iso3 <> 'WLD' AND value_usd > 0
GROUP BY flow, year, partner_iso3
"""


def pct_change(frm, to):
    if frm is None or frm <= 0 or not math.isfinite(to):
        return None
    return (to - frm) / frm * 100


def cagr(frm, to, periods):
    if frm is None or frm <= 0 or to <= 0 or periods <= 0:
        return None
    return (math.pow(to / frm, 1 / periods) - 1) * 100


def has_real_base(frm, floor):
    return frm is not None and frm >= floor / GROWTH_BASE_DIVISOR


def nearest_past_year(years, target, before):
    best, dist = None, math.inf
    for y in years:
        if y >= before:
            continue
        d = abs(y - target)
        if d < dist:
            best, dist = y, d
    return best


def previous_year(years, year):
    i = years.index(year) if year in years else -1
    return years[i - 1] if i > 0 else None


def coverage_note(years, latest, product_year, this_year):
    notes = []
    lag = this_year - latest
    if lag >= 3:
        notes.append(f"Most recent year with both exports and imports reported is {latest}. "
                     f"Trade statistics normally lag by 1\u20132 years; this one lags by {lag}.")
    if len(years) < 3:
        notes.append(f"Only {len(years)} comparable year{'' if len(years) == 1 else 's'} available, "
                     "so trend lines are indicative.")
    if product_year != latest:
        notes.append(f"Headline totals are for {latest}; the product breakdown is the most recent available, {product_year}.")
    gaps = years[-1] - years[0] + 1 - len(years) if len(years) > 1 else 0
    if gaps > 0:
        notes.append(f"{gaps} year{'' if gaps == 1 else 's'} in this range were not reported and are omitted from the chart.")
    return " ".join(notes) or None


def build_dashboard(reporter: str, product_rows: list[tuple], partner_rows: list[tuple], this_year: int | None = None) -> dict | None:
    """product_rows: (flow, year, code, desc, level, value). partner_rows: (flow, year, iso3, value)."""
    this_year = this_year or datetime.now(timezone.utc).year
    prod: dict[tuple, dict] = {}
    totals: dict[tuple, float] = {}
    for flow, year, code, desc, lvl, v in product_rows:
        if v is None:
            continue
        year = int(year)
        prod[(flow, year, code)] = {"code": code, "desc": desc, "level": lvl, "v": float(v)}
        totals[(flow, year)] = totals.get((flow, year), 0.0) + float(v)
    exp_years = {y for (f, y) in totals if f == "X" and totals[(f, y)] > 0}
    imp_years = {y for (f, y) in totals if f == "M" and totals[(f, y)] > 0}
    years = sorted(exp_years & imp_years) or sorted({y for (_, y) in totals})
    if not years:
        return None
    latest = years[-1]
    prev = years[-2] if len(years) >= 2 else None
    product_years = sorted({y for (_, y, _c) in prod})
    product_year = next((y for y in reversed(product_years) if y <= latest), product_years[-1])

    trend = [{"year": y, "export_usd": totals.get(("X", y), 0.0), "import_usd": totals.get(("M", y), 0.0),
              "balance_usd": totals.get(("X", y), 0.0) - totals.get(("M", y), 0.0)} for y in years]
    latest_pt = trend[-1]
    prev_pt = next((t for t in trend if t["year"] == prev), None)

    def rank_products(flow: str) -> list[dict]:
        cur = [p for (f, y, _c), p in prod.items() if f == flow and y == product_year and p["v"] > 0]
        if not cur:
            return []
        level_len = max(len(p["code"]) for p in cur)
        specific = level_len >= 6
        reported = totals.get((flow, product_year), 0.0)
        total = reported if reported > 0 else sum(p["v"] for p in cur)
        if total <= 0:
            return []
        three_back = nearest_past_year(product_years, product_year - 3, product_year)
        prev_y = previous_year(product_years, product_year)
        floor = NOISE_FLOOR_SPECIFIC_USD if specific else NOISE_FLOOR_CHAPTER_USD
        out = []
        for i, p in enumerate(sorted(cur, key=lambda p: (-p["v"], p["code"]))[:RANKED_TOP_N]):
            past = prod.get((flow, three_back, p["code"]), {}).get("v") if three_back is not None else None
            last = prod.get((flow, prev_y, p["code"]), {}).get("v") if prev_y is not None else None
            c3 = cagr(past, p["v"], product_year - three_back) if three_back is not None and has_real_base(past, floor) else None
            out.append({"rank": i + 1, "code": p["code"], "name": p["desc"] or p["code"], "value_usd": p["v"],
                        "share_pct": p["v"] / total * 100, "cagr_3y": c3,
                        "yoy_pct": pct_change(last, p["v"]) if has_real_base(last, floor) else None})
        return out

    ptot = {(f, y, i): float(v) for f, y, i, v in partner_rows}

    def rank_partners(flow: str) -> list[dict]:
        cur = [(i, v) for (f, y, i), v in ptot.items() if f == flow and y == latest and i != reporter]
        total = sum(v for _, v in cur)
        if total <= 0:
            return []
        three_back = nearest_past_year(years, latest - 3, latest)
        prev_y = previous_year(years, latest)
        out = []
        for n, (iso, v) in enumerate(sorted(cur, key=lambda x: (-x[1], x[0]))[:RANKED_TOP_N]):
            past = ptot.get((flow, three_back, iso)) if three_back is not None else None
            last = ptot.get((flow, prev_y, iso)) if prev_y is not None else None
            out.append({"rank": n + 1, "code": iso, "name": NAMES.get(iso, iso), "value_usd": v,
                        "share_pct": v / total * 100,
                        "cagr_3y": cagr(past, v, latest - three_back) if three_back is not None else None,
                        "yoy_pct": pct_change(last, v)})
        return out

    exp_total, imp_total = latest_pt["export_usd"], latest_pt["import_usd"]
    ch: dict[str, float] = {}
    for (f, y, code), p in prod.items():
        if f == "X" and y == product_year and p["v"] > 0:
            ch[code[:2]] = ch.get(code[:2], 0.0) + p["v"]
    ch_total = sum(ch.values())
    shares = {k: v / ch_total for k, v in ch.items()} if ch_total > 0 else {}
    overview = {
        "year": latest, "export_usd": exp_total, "import_usd": imp_total, "balance_usd": exp_total - imp_total,
        "total_trade_usd": exp_total + imp_total,
        "export_yoy_pct": pct_change(prev_pt["export_usd"] if prev_pt else None, exp_total),
        "import_yoy_pct": pct_change(prev_pt["import_usd"] if prev_pt else None, imp_total),
        "export_concentration": sum(s * s for s in shares.values()) if shares else None,
        "export_chapter_shares": shares,
        "partner_count": len({i for (_, y, i) in ptot if y == latest and i != reporter}),
        "product_count": len({code for (_, y, code), p in prod.items() if y == product_year and p["v"] > 0}),
        "services_export_usd": None, "services_import_usd": None,
        "data_sources": ["un-comtrade"],
        "coverage_note": coverage_note(years, latest, product_year, this_year),
    }
    return {"overview": overview, "top_exports": rank_products("X"), "top_imports": rank_products("M"),
            "partners_export": rank_partners("X"), "partners_import": rank_partners("M"), "trend": trend}


def load_dashboard(conn, reporter: str) -> dict | None:
    cur = conn.cursor()
    cur.execute(PRODUCT_TOTALS_SQL, {"rep": reporter})
    prows = cur.fetchall()
    cur.execute(PARTNER_TOTALS_SQL, {"rep": reporter})
    parts = cur.fetchall()
    d = build_dashboard(reporter, prows, parts)
    if d is None:
        return None
    cur.execute("SELECT TO_CHAR(MAX(ingested_at), 'YYYY-MM-DD\"T\"HH24:MI:SS') FROM tf_trade_facts WHERE reporter_iso3 = :rep",
                {"rep": reporter})
    d["computed_at"] = cur.fetchone()[0]
    return d


def load_lines(conn, reporter: str, flow: str) -> dict | None:
    """Product lines for the latest year of a flow, for the family grouping done in the Worker."""
    cur = conn.cursor()
    cur.execute(PRODUCT_TOTALS_SQL, {"rep": reporter})
    rows = [r for r in cur.fetchall() if r[0] == flow and r[5] is not None]
    if not rows:
        return None
    year = max(int(r[1]) for r in rows)
    cur_rows = [r for r in rows if int(r[1]) == year]
    total = sum(float(r[5]) for r in cur_rows)
    lines = [{"hs_code": r[2], "product_name": r[3], "value_usd": float(r[5])}
             for r in cur_rows if float(r[5]) > 0 and len(r[2]) >= 6 and not r[2].startswith("99")]
    return {"year": year, "country_total_usd": total, "lines": lines}


def refresh_dashboard(conn, reporter: str) -> int:
    """Store the dashboard and family line payloads for one reporter. Returns payloads written."""
    from . import opportunity
    payloads = {"dashboard": load_dashboard(conn, reporter),
                "lines_X": load_lines(conn, reporter, "X"), "lines_M": load_lines(conn, reporter, "M")}
    if reporter in opportunity.CONFIG:
        payloads["blue_oceans"] = {"reporter": reporter, "blue_oceans": opportunity.blue_oceans(conn, reporter, 50)}
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM tf_dashboard_cache WHERE reporter_iso3 = :1", [reporter])
        n = 0
        for kind, val in payloads.items():
            if val is not None:
                cur.execute("INSERT INTO tf_dashboard_cache (reporter_iso3, kind, payload) VALUES (:1, :2, :3)",
                            [reporter, kind, json.dumps(val)])
                n += 1
        conn.commit()
        return n
    except Exception:
        conn.rollback()
        raise


def read_cached(conn, reporter: str, kind: str) -> dict | None:
    cur = conn.cursor()
    cur.execute("SELECT payload FROM tf_dashboard_cache WHERE reporter_iso3 = :1 AND kind = :2", [reporter, kind])
    row = cur.fetchone()
    if not row:
        return None
    raw = row[0].read() if hasattr(row[0], "read") else row[0]
    return json.loads(raw)
