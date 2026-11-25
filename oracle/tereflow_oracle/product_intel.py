"""Product intelligence: demand, supply, concentration, competitiveness and market-pressure indicators for each HS6
product, computed from the stored Comtrade facts (tf_trade_facts) with the formulas in trade_methods.py.

Two things the numbers always carry with them:

* Coverage. Tereflow holds imports and exports as reported by the countries it ingests, not the whole world. Every
  "global" total here means "all reporting countries in the universe", and the universe is listed in the result.
  Markets are the importers that reported in both the base and the latest year, so growth compares like with like.
* Kind. Observed (reported trade), derived (a formula on observed data), and heuristic (a signal from a documented
  rule) are kept apart. Nothing here is a forecast or a shortage estimate.

The state labels in `pressure` are positions in the cross-product distribution (top or bottom fifth of products that
trade at least MIN_VALUE_USD), taken from the data in the same run. There are no fixed cut-offs and no composite score.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict

from . import markets
from . import intel_extra as ie
from . import trade_methods as tm

MIN_VALUE_USD = 100_000          # products below this latest-year import value get figures but no pressure states
TOP_N = 15
CMS_EXPORTERS = 10
CMS_MARKETS = 8
MIN_IMPORTERS = 8                # a year counts as the latest year only if at least this many importers reported it

DDL = [
    """CREATE TABLE app_pi_product (hs6 VARCHAR2(6) PRIMARY KEY, method_version VARCHAR2(12), base_year NUMBER, latest_year NUMBER,
       demand_usd NUMBER, computed_at VARCHAR2(30), payload CLOB, name VARCHAR2(300))""",
    """CREATE TABLE app_pi_meta (k VARCHAR2(40) PRIMARY KEY, v CLOB, updated_at VARCHAR2(30))""",
]
TABLES = ["pi_product", "pi_meta"]

METHODS = {
    "version": tm.METHOD_VERSION,
    "universe": "Importers that reported in both the base and the latest year. 'Global' means these reporters only.",
    "imports": "Reported imports of the importers in the universe. Unattributed partner areas stay in totals and never count as a supplier.",
    "shares": "Share of reported imports of the product in the universe.",
    "hhi": "Sum of squared supplier shares (0 to 1) over named countries, as in the Trade Sandbox.",
    "unit_value": "Trade value per reported kilogram. A proxy that moves with product mix and quality, not a transaction price.",
    "rca": "Balassa: (supplier's share of its sales into the universe that is this product) divided by (this product's share of all imports into the universe). Same universe and year for all four terms.",
    "cms": ("Constant market share, standard three-effect form plus a new-market term: growth, distribution, competitiveness. "
            "Effects add up to the change in the supplier's sales exactly. Competitiveness is an accounting residual, not proof of productivity. "
            "The source papers could not be retrieved in this environment, so the form is the standard textbook decomposition and is not yet checked against them."),
    "mirror": "Exports reported by a supplier against imports reported by the buyer for the same pair and year. Differences are expected (freight and insurance, timing, re-exports).",
    "pressure": ("Positions in the cross-product distribution, from this run. 'potential supply pressure' is a heuristic: reported export quantity in the top "
                 "fifth while unit value is in the bottom fifth. It is not an observed shortage or surplus."),
    "opportunities": ("Screening of the eight largest importing markets. A candidate supplier is listed when it is not already entrenched in that market (under 5 percent share) "
                      "and meets at least two of: Balassa RCA above 1, global growth above the market's growth, unit value below the market's, within 8000 km. "
                      "It is a screening signal from reported trade, not a forecast and not proof of unmet demand. Tariffs, standards, logistics cost and buyers are not in the data."),
    "armington": ("Descriptive only: supplier unit values against the market, and how supplier share changes line up with relative unit-value changes (a rank correlation). "
                  "Armington substitution elasticities are not estimated; that needs a long price and quantity panel by buyer and an identification design."),
    "gravity": ("Poisson pseudo-maximum-likelihood gravity model per HS chapter, with importer and exporter fixed effects (which absorb size and multilateral resistance) and CEPII "
                "distance, contiguity, common language and colonial tie. Fitted values are model-expected trade, an estimate kept apart from observed imports. A gap is not unmet demand. "
                "Each chapter is validated on a random 20 percent hold-out against a no-trade-cost baseline and the result is shown whether or not the model wins. "
                "The two source papers could not be retrieved here, so the specification is the standard one and is not yet checked against them."),
    "mapping": ("HS to industry through official UN correspondence tables: HS to CPC 2.1 to ISIC Rev.4 to the Eurostat FIGARO industry. The tables give possible pairings with no weights, "
                "so none are shown. Category is direct (one industry reached), derived multiple (several, unweighted) or unresolved."),
    "network": ("Eurostat FIGARO inter-country input-output table (industry by industry, current basic prices, million EUR). Direct requirement a = input from supplier industry per euro of the "
                "industry's output. Total requirement is from the Leontief inverse (I - A)^-1; indirect = total - direct. These are industry averages, not a bill of materials for the product."),
    "not_implemented": ["Armington substitution elasticities (needs a long price and quantity panel by buyer and an identification design)",
                        "OECD ICIO and other input-output sources (the OECD site refused downloads from this machine; Eurostat FIGARO is the primary source)",
                        "Tariffs, standards and logistics cost in opportunity screening (no data loaded)"],
}


def create_tables(conn, log=print) -> None:
    cur = conn.cursor()
    for s in DDL:
        try:
            cur.execute(s)
            log("created: " + s.split("(")[0].strip())
        except Exception as e:
            if "ORA-00955" in str(e):
                continue
            raise
    conn.commit()


def choose_years(counts: dict, years_back: int = 3):
    """counts: {year: number of importers that reported}. Latest year = newest with enough importers; base = latest - years_back,
    or the nearest earlier year that also has enough importers."""
    ok = sorted(y for y, n in counts.items() if n >= MIN_IMPORTERS)
    if len(ok) < 2:
        return None, None
    latest = ok[-1]
    want = latest - years_back
    earlier = [y for y in ok if y < latest]
    base = min(earlier, key=lambda y: (abs(y - want), y))
    return base, latest


def _r(v, nd=2):
    return None if v is None else round(v, nd)


def build_product(hs6: str, desc, imp: dict, exp: dict, ctx: dict) -> tuple:
    """imp: {(importer, partner, year): (value, kg)}; exp: {(exporter, partner, year): (value, kg)} for one product.
    ctx: base, latest, universe (set), complete_years (set), supplier_total (partner -> total into universe at latest), world_total.
    Returns (payload, indicators)."""
    B, L, U = ctx["base"], ctx["latest"], ctx["universe"]

    mt = {}
    for (m, p, y), (v, kg) in imp.items():
        if m not in U:
            continue
        a = mt.setdefault((m, y), [None, None])
        if v is not None:
            a[0] = (a[0] or 0.0) + v
        if kg is not None:
            a[1] = (a[1] or 0.0) + kg

    def imp_sum(year, importer=None, idx=0):
        t, seen = 0.0, False
        for m in ([importer] if importer else U):
            a = mt.get((m, year))
            if a and a[idx] is not None:
                t += a[idx]
                seen = True
        return t if seen else None
    years = sorted({y for (_, _, y) in imp} | {y for (_, _, y) in exp})
    series = []
    for y in years:
        if y not in ctx["complete_years"]:
            continue
        val, kg = imp_sum(y), imp_sum(y, idx=1)
        series.append({"year": y, "value_usd": _r(val, 0), "weight_kg": _r(kg, 0), "unit_value": _r(tm.unit_value(val, kg), 4)})

    dem_L, dem_B = imp_sum(L), imp_sum(B)
    kg_L, kg_B = imp_sum(L, idx=1), imp_sum(B, idx=1)
    uv_L, uv_B = tm.unit_value(dem_L, kg_L), tm.unit_value(dem_B, kg_B)

    # importers
    iv_L = {m: imp_sum(L, importer=m) for m in U}
    iv_B = {m: imp_sum(B, importer=m) for m in U}
    sh_L, sh_B = tm.shares(iv_L), tm.shares(iv_B)
    rk_L, rk_B = tm.rank_of({k: v for k, v in iv_L.items() if v}), tm.rank_of({k: v for k, v in iv_B.items() if v})
    importers = []
    for m, v in sorted(((k, v) for k, v in iv_L.items() if v), key=lambda kv: -kv[1])[:TOP_N]:
        importers.append({"iso3": m, "value_usd": _r(v, 0), "share_pct": _r(sh_L.get(m), 3), "base_usd": _r(iv_B.get(m), 0),
                          "growth_pct": _r(tm.pct_change(iv_B.get(m), v)), "rank": rk_L.get(m),
                          "rank_change": (rk_B[m] - rk_L[m]) if m in rk_B and m in rk_L else None})

    # suppliers (named countries only)
    sup_L, sup_B, sup_kgL, sup_kgB = defaultdict(float), defaultdict(float), defaultdict(float), defaultdict(float)
    for (m, p, y), (v, kg) in imp.items():
        if m not in U or not markets.is_market(p) or v is None:
            continue
        if y == L:
            sup_L[p] += v
            sup_kgL[p] += kg or 0
        elif y == B:
            sup_B[p] += v
            sup_kgB[p] += kg or 0
    sh_sL, sh_sB = tm.shares(dem_share_base(sup_L, dem_L)), tm.shares(dem_share_base(sup_B, dem_B))
    srk_L, srk_B = tm.rank_of(sup_L), tm.rank_of(sup_B)
    hhi_L, hhi_B = tm.hhi(sup_L), tm.hhi(sup_B)
    top_L = max(sh_sL.values()) if sh_sL else None
    top_B = max(sh_sB.values()) if sh_sB else None
    suppliers = []
    for p, v in sorted(sup_L.items(), key=lambda kv: -kv[1])[:TOP_N]:
        suppliers.append({"iso3": p, "value_usd": _r(v, 0), "share_pct": _r(sh_sL.get(p), 3), "base_usd": _r(sup_B.get(p), 0),
                          "share_change_pp": _r((sh_sL.get(p, 0) - sh_sB.get(p, 0)) if p in sh_sB or p in sh_sL else None, 3),
                          "growth_pct": _r(tm.pct_change(sup_B.get(p), v)), "unit_value": _r(tm.unit_value(v, sup_kgL.get(p)), 4),
                          "rank": srk_L.get(p), "rank_change": (srk_B[p] - srk_L[p]) if p in srk_B and p in srk_L else None})

    # competitiveness: CMS and RCA for the leading suppliers
    comp = []
    for p, _ in sorted(sup_L.items(), key=lambda kv: -kv[1])[:CMS_EXPORTERS]:
        cells = {}
        for m in U:
            if m == p:
                continue
            x0 = imp.get((m, p, B), (None, None))[0]
            x1 = imp.get((m, p, L), (None, None))[0]
            cells[m] = (x0, x1, imp_sum(B, importer=m), imp_sum(L, importer=m))
        c = tm.cms(cells)
        rca = tm.balassa_rca(sup_L[p], ctx["supplier_total"].get(p), dem_L, ctx["world_total"])
        entry = {"iso3": p, "rca": _r(rca, 3), "rca_terms": {"supplier_product_usd": _r(sup_L[p], 0), "supplier_all_usd": _r(ctx["supplier_total"].get(p), 0),
                                                              "world_product_usd": _r(dem_L, 0), "world_all_usd": _r(ctx["world_total"], 0)}}
        if c.get("ok"):
            top_mk = sorted(c["markets"], key=lambda r: -abs(r["change"]))[:CMS_MARKETS]
            entry["cms"] = {k: _r(c[k], 0) for k in ("x0", "x1", "total_change", "growth", "distribution", "competitiveness", "new_markets", "check_gap")}
            entry["cms"]["market_growth_pct"] = _r(c["r_pct"])
            entry["cms"]["excluded_markets"] = c["excluded"]
            entry["cms"]["markets"] = [{"iso3": r["market"], "change": _r(r["change"], 0), "growth": _r(r["growth"], 0), "distribution": _r(r["distribution"], 0),
                                        "competitiveness": _r(r["competitiveness"], 0), "new_market": _r(r["new_market"], 0)} for r in top_mk]
        comp.append(entry)

    # mirror check: what suppliers in the universe say they exported against what buyers say they imported, latest year
    exp_rep = imp_rep = 0.0
    pairs = 0
    for (c_, m, y), (v, _) in exp.items():
        if y != L or c_ not in U or m not in U or v is None:
            continue
        i = imp.get((m, c_, L), (None, None))[0]
        if i is None:
            continue
        exp_rep += v
        imp_rep += i
        pairs += 1
    mirror = {"pairs": pairs, "exports_reported_usd": _r(exp_rep, 0), "imports_reported_usd": _r(imp_rep, 0),
              "imports_over_exports": _r(imp_rep / exp_rep if exp_rep > 0 else None, 3)}

    # reported exports by the universe's own countries (supply side as reported, coverage-limited)
    ex_L = sum(v[0] or 0 for (c_, _, y), v in exp.items() if y == L and c_ in U)
    ex_B = sum(v[0] or 0 for (c_, _, y), v in exp.items() if y == B and c_ in U)
    exq_L = sum(v[1] or 0 for (c_, _, y), v in exp.items() if y == L and c_ in U)
    exq_B = sum(v[1] or 0 for (c_, _, y), v in exp.items() if y == B and c_ in U)
    exuv_L, exuv_B = tm.unit_value(ex_L, exq_L), tm.unit_value(ex_B, exq_B)

    ind = {
        "demand_value_growth": tm.pct_change(dem_B, dem_L), "demand_qty_growth": tm.pct_change(kg_B, kg_L),
        "unit_value_change": tm.pct_change(uv_B, uv_L),
        "hhi_change": (hhi_L - hhi_B) if hhi_L is not None and hhi_B is not None else None,
        "top_share_change_pp": (top_L - top_B) if top_L is not None and top_B is not None else None,
        "supply_qty_growth": tm.pct_change(exq_B, exq_L), "supply_value_growth": tm.pct_change(ex_B, ex_L),
        "supply_unit_value_change": tm.pct_change(exuv_B, exuv_L),
        "demand_usd": dem_L,
    }
    payload = {
        "hs6": hs6, "description": desc, "method_version": tm.METHOD_VERSION,
        "period": {"base": B, "latest": L},
        "coverage": {"importers": sorted(U), "importer_count": len(U), "reporters_not_in_universe": ctx["excluded_reporters"],
                     "note": "Totals are reported imports of the importers listed, not the whole world."},
        "demand": {"value_usd": _r(dem_L, 0), "base_usd": _r(dem_B, 0), "growth_pct": _r(ind["demand_value_growth"]),
                   "weight_kg": _r(kg_L, 0), "base_weight_kg": _r(kg_B, 0), "weight_growth_pct": _r(ind["demand_qty_growth"]),
                   "unit_value": _r(uv_L, 4), "base_unit_value": _r(uv_B, 4), "unit_value_change_pct": _r(ind["unit_value_change"]),
                   "series": series, "importers": importers},
        "supply": {"suppliers": suppliers, "supplier_count": len(sup_L), "hhi": _r(hhi_L, 4), "base_hhi": _r(hhi_B, 4),
                   "hhi_change": _r(ind["hhi_change"], 4), "top_share_pct": _r(top_L, 2), "base_top_share_pct": _r(top_B, 2),
                   "reported_exports": {"value_usd": _r(ex_L, 0), "base_usd": _r(ex_B, 0), "value_growth_pct": _r(ind["supply_value_growth"]),
                                        "weight_kg": _r(exq_L, 0), "weight_growth_pct": _r(ind["supply_qty_growth"]),
                                        "unit_value": _r(exuv_L, 4), "unit_value_change_pct": _r(ind["supply_unit_value_change"]),
                                        "note": "Exports reported by countries in the universe only."}},
        "competitiveness": comp, "mirror": mirror,
        "pressure": {"indicators": {k: _r(v, 4) for k, v in ind.items() if k != "demand_usd"}, "states": [], "note": None},
    }
    rca_by = {p: tm.balassa_rca(sup_L[p], ctx["supplier_total"].get(p), dem_L, ctx["world_total"]) for p in sorted(sup_L, key=lambda k: -sup_L[k])[:ie.TOP_SUPPLIERS]}
    payload["opportunities"] = ie.screen_markets(imp, U, B, L, rca_by, ctx.get("geo"))
    payload["armington"] = ie.armington_descriptive(sup_L, sup_B, sup_kgL, sup_kgB)
    return payload, ind


def dem_share_base(sup: dict, total) -> dict:
    """Supplier values for shares of the reported total, with unattributed areas kept in the denominator."""
    t = sum(sup.values())
    if total and total > t:
        return {**sup, "~unattributed": total - t}
    return dict(sup)


STATE_RULES = [
    ("demand_qty_growth", "high", "demand_strengthening", "Reported import quantity grew faster than most products"),
    ("demand_qty_growth", "low", "demand_weakening", "Reported import quantity grew slower than most products"),
    ("unit_value_change", "high", "unit_value_rising", "Trade value per kg rose more than for most products"),
    ("unit_value_change", "low", "unit_value_falling", "Trade value per kg fell more than for most products"),
    ("hhi_change", "high", "supplier_concentration_increasing", "Supplier concentration rose more than for most products"),
    ("hhi_change", "low", "supplier_concentration_decreasing", "Supplier concentration fell more than for most products"),
    ("supply_qty_growth", "high", "supply_expansion", "Reported export quantity grew faster than most products"),
]


def apply_states(payload: dict, ind: dict, cuts: dict) -> None:
    states = []
    if (ind.get("demand_usd") or 0) < MIN_VALUE_USD:
        payload["pressure"]["note"] = f"Too small to label: reported imports are under ${MIN_VALUE_USD:,} in the latest year."
        return
    band = {k: tm.band_state(ind.get(k), cuts.get(k, {})) for k in cuts}
    for key, want, label, why in STATE_RULES:
        if band.get(key) == want:
            states.append({"state": label, "kind": "derived", "basis": why, "value": _r(ind.get(key), 4)})
    if band.get("supply_qty_growth") == "high" and band.get("supply_unit_value_change") == "low":
        states.append({"state": "potential_supply_pressure", "kind": "heuristic",
                       "basis": "Reported export quantity is in the top fifth of products while export unit value is in the bottom fifth. A signal to check, not an observed shortage or surplus.",
                       "value": None})
    payload["pressure"]["states"] = states
    payload["pressure"]["cuts"] = {k: {"low": _r(v.get("low"), 4), "high": _r(v.get("high"), 4), "products": v.get("n")} for k, v in cuts.items()}
    payload["pressure"]["note"] = "States are positions among products in the same run. There is no composite score."


BAND_KEYS = ["demand_qty_growth", "unit_value_change", "hhi_change", "supply_qty_growth", "supply_unit_value_change"]


def compute_cuts(all_ind: list) -> dict:
    return {k: tm.bands([i.get(k) for i in all_ind if (i.get("demand_usd") or 0) >= MIN_VALUE_USD]) for k in BAND_KEYS}


# --------------------------------------------------------------------------------------------------------------
# Database side
# --------------------------------------------------------------------------------------------------------------

def load_context(conn, log=print) -> dict:
    cur = conn.cursor()
    cur.execute("SELECT year, COUNT(DISTINCT reporter_iso3) FROM tf_trade_facts WHERE flow = 'M' GROUP BY year")
    counts = {int(y): int(n) for y, n in cur}
    base, latest = choose_years(counts)
    if base is None:
        raise RuntimeError(f"Not enough importers to compare two years: {counts}")
    cur.execute("SELECT DISTINCT reporter_iso3, year FROM tf_trade_facts WHERE flow = 'M' AND year IN (:1, :2)", [base, latest])
    have = defaultdict(set)
    for r, y in cur:
        have[r].add(int(y))
    universe = {r for r, ys in have.items() if {base, latest} <= ys}
    excluded = sorted(set(have) - universe)
    cur.execute("SELECT DISTINCT reporter_iso3, year FROM tf_trade_facts WHERE flow = 'M'")
    by_year = defaultdict(set)
    for r, y in cur:
        by_year[int(y)].add(r)
    complete = {y for y, rs in by_year.items() if universe <= rs}
    cur.execute("SELECT TRIM(partner_iso3), SUM(value_usd) FROM tf_trade_facts WHERE flow = 'M' AND year = :1 AND partner_iso3 <> 'WLD' GROUP BY TRIM(partner_iso3)", [latest])
    sup_total_all = {p: float(v or 0) for p, v in cur}
    # restrict to the universe's imports
    ph = ",".join(f":{i + 2}" for i in range(len(universe)))
    cur.execute(f"SELECT TRIM(partner_iso3), SUM(value_usd) FROM tf_trade_facts WHERE flow = 'M' AND year = :1 AND partner_iso3 <> 'WLD' AND reporter_iso3 IN ({ph}) GROUP BY TRIM(partner_iso3)",
                [latest, *sorted(universe)])
    sup_total = {p: float(v or 0) for p, v in cur}
    world = sum(sup_total.values())
    log(f"base {base}, latest {latest}, universe {len(universe)} importers, excluded {excluded}, complete years {sorted(complete)}")
    try:
        from . import gravity
        geo = gravity.load_geo(conn)
    except Exception:
        geo = {}
    return {"base": base, "latest": latest, "universe": universe, "excluded_reporters": excluded, "complete_years": complete, "geo": geo,
            "supplier_total": sup_total, "world_total": world, "year_counts": counts}


def stream_products(conn, prefix=None, exact=None, arraysize=50000):
    """Yield (hs6, imp, exp) one product at a time, from a single ordered aggregate over the facts table."""
    cur = conn.cursor()
    cur.arraysize = arraysize
    where, binds = "partner_iso3 <> 'WLD'", {}
    if exact:
        where += " AND SUBSTR(cmd_code, 1, 6) = :hs"
        binds["hs"] = exact
    elif prefix:
        where += " AND cmd_code LIKE :pre"
        binds["pre"] = prefix + "%"
    cur.execute(f"""SELECT SUBSTR(cmd_code, 1, 6) AS hs6, reporter_iso3, TRIM(partner_iso3), year, flow, SUM(value_usd), SUM(net_weight_kg)
                      FROM tf_trade_facts WHERE {where}
                     GROUP BY SUBSTR(cmd_code, 1, 6), reporter_iso3, TRIM(partner_iso3), year, flow
                     ORDER BY SUBSTR(cmd_code, 1, 6)""", binds)
    cur_hs, imp, exp = None, {}, {}
    for hs6, rep, par, yr, flow, val, kg in cur:
        if len(hs6) < 6:
            continue
        if hs6 != cur_hs:
            if cur_hs is not None:
                yield cur_hs, imp, exp
            cur_hs, imp, exp = hs6, {}, {}
        key = (rep, par, int(yr))
        target = imp if flow == "M" else exp
        target[key] = (None if val is None else float(val), None if kg is None else float(kg))
    if cur_hs is not None:
        yield cur_hs, imp, exp


def run(conn, prefix=None, exact=None, write=True, log=print, limit=None) -> dict:
    t0 = time.time()
    ctx = load_context(conn, log)
    cur = conn.cursor()
    cur.execute("SELECT code, name FROM tf_hs6_name")
    names = {c: n for c, n in cur}
    results, inds = {}, {}
    n = 0
    for hs6, imp, exp in stream_products(conn, prefix, exact):
        if not imp:
            continue
        payload, ind = build_product(hs6, names.get(hs6), imp, exp, ctx)
        results[hs6], inds[hs6] = payload, ind
        n += 1
        if n % 500 == 0:
            log(f"  {n} products, {int(time.time() - t0)}s")
        if limit and n >= limit:
            break
    if prefix or exact or limit:
        try:
            cur.execute("SELECT v FROM app_pi_meta WHERE k = 'cuts'")
            row = cur.fetchone()
        except Exception:
            row = None
        cuts = json.loads(row[0]) if row and row[0] else compute_cuts(list(inds.values()))
        cuts_note = "stored" if row else "this subset"
    else:
        cuts = compute_cuts(list(inds.values()))
        cuts_note = "full run"
    for hs6, payload in results.items():
        apply_states(payload, inds[hs6], cuts)
    log(f"{len(results)} products built, bands from {cuts_note}")
    if write:
        write_results(conn, results, inds, cuts, ctx, full=not (prefix or exact or limit))
    return {"products": len(results), "results": results, "cuts": cuts, "context": {k: (sorted(v) if isinstance(v, set) else v) for k, v in ctx.items() if k not in ("supplier_total", "geo")},
            "seconds": round(time.time() - t0, 1)}


def write_results(conn, results: dict, inds: dict, cuts: dict, ctx: dict, full: bool) -> None:
    cur = conn.cursor()
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    rows = [(hs6, tm.METHOD_VERSION, ctx["base"], ctx["latest"], inds[hs6].get("demand_usd"), now, json.dumps(p, separators=(",", ":")), (p.get("description") or "")[:300])
            for hs6, p in results.items()]
    if full:
        cur.execute("DELETE FROM app_pi_product")
    else:
        cur.executemany("DELETE FROM app_pi_product WHERE hs6 = :1", [(r[0],) for r in rows])
    cur.setinputsizes(None, None, None, None, None, None, __import__("oracledb").DB_TYPE_CLOB, None)
    cur.executemany("INSERT INTO app_pi_product (hs6, method_version, base_year, latest_year, demand_usd, computed_at, payload, name) VALUES (:1, :2, :3, :4, :5, :6, :7, :8)", rows)
    meta = {"methods": METHODS, "cuts": cuts if full else None,
            "run": {"products": len(results), "base": ctx["base"], "latest": ctx["latest"], "importers": sorted(ctx["universe"]),
                    "excluded_reporters": ctx["excluded_reporters"], "year_counts": ctx["year_counts"], "computed_at": now, "full": full}}
    for k, v in meta.items():
        if v is None:
            continue
        cur.execute("DELETE FROM app_pi_meta WHERE k = :1", [k if k != "run" or full else "run_partial"])
        cur.execute("INSERT INTO app_pi_meta (k, v, updated_at) VALUES (:1, :2, :3)", [k if k != "run" or full else "run_partial", json.dumps(v), now])
    conn.commit()
