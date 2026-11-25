"""Market screening and Armington-style descriptive supplier analysis for one product. Pure functions.

Nothing here estimates demand that is not there or a substitution elasticity. A market opportunity is a screening signal:
a market whose reported imports are growing, with suppliers that fit on observable evidence. It needs commercial
validation (prices, tariffs, standards, buyers) that the data does not hold.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Optional

from . import markets
from . import trade_methods as tm

TOP_MARKETS = 8
TOP_SUPPLIERS = 15
MAX_CANDIDATES = 5
ENTRENCHED_SHARE_PCT = 5.0

LIMITS = [
    "Reported imports only: growth in imports is not proof of unmet demand.",
    "Tariffs, standards, regulation, logistics cost and buyer relationships are not in the data, so they are not scored.",
    "Distance is straight-line distance between main cities (CEPII GeoDist), not freight cost.",
    "Candidates are suppliers already trading this product with the coverage countries; suppliers with no reported sales are not seen.",
]


def _geo(geo: Optional[dict], a: str, b: str) -> Optional[dict]:
    if not geo:
        return None
    return geo.get((a, b)) or geo.get((b, a))


def _spearman(xs: list, ys: list) -> Optional[float]:
    pts = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pts) < 8:
        return None
    rx = tm.rank_of({i: p[0] for i, p in enumerate(pts)})
    ry = tm.rank_of({i: p[1] for i, p in enumerate(pts)})
    n = len(pts)
    mx = sum(rx.values()) / n
    my = sum(ry.values()) / n
    sxy = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    sxx = sum((rx[i] - mx) ** 2 for i in range(n))
    syy = sum((ry[i] - my) ** 2 for i in range(n))
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / (sxx * syy) ** 0.5


def screen_markets(imp: dict, universe: set, base: int, latest: int, rca_by: dict, geo: Optional[dict] = None) -> dict:
    """imp: {(importer, partner, year): (value, kg)}. rca_by: supplier -> Balassa RCA (None allowed)."""
    tot = {}
    sup = defaultdict(lambda: defaultdict(float))
    kgs = defaultdict(float)
    for (m, p, y), (v, kg) in imp.items():
        if m not in universe or v is None:
            continue
        t = tot.setdefault((m, y), [0.0, 0.0])
        t[0] += v
        t[1] += kg or 0.0
        if markets.is_market(p):
            sup[(m, y)][p] += v
            if y == latest:
                kgs[(m, p)] += kg or 0.0
    glob_L, glob_B, glob_kg = defaultdict(float), defaultdict(float), defaultdict(float)
    for (m, y), d in sup.items():
        for p, v in d.items():
            if y == latest:
                glob_L[p] += v
            elif y == base:
                glob_B[p] += v
    for (m, p), k in kgs.items():
        glob_kg[p] += k
    top_sup = [p for p, _ in sorted(glob_L.items(), key=lambda kv: -kv[1])[:TOP_SUPPLIERS]]
    uv_mkt_global = tm.unit_value(sum(t[0] for (m, y), t in tot.items() if y == latest), sum(t[1] for (m, y), t in tot.items() if y == latest))

    rows = []
    ranked = sorted(((m, tot[(m, latest)][0]) for (m, y) in tot if y == latest and tot[(m, latest)][0] > 0), key=lambda kv: -kv[1])[:TOP_MARKETS]
    for m, val_L in ranked:
        val_B, kg_L, kg_B = (tot.get((m, base)) or [None, None])[0], tot[(m, latest)][1], (tot.get((m, base)) or [None, None])[1]
        s_L = sup.get((m, latest), {})
        sh = tm.shares(s_L)
        hh = tm.hhi(s_L)
        g_mkt = tm.pct_change(val_B, val_L)
        uv_m = tm.unit_value(val_L, kg_L)
        cands = []
        for p in top_sup:
            if p == m:
                continue
            share_here = 100.0 * s_L.get(p, 0.0) / val_L if val_L else 0.0
            if share_here >= ENTRENCHED_SHARE_PCT:
                continue
            g_sup = tm.pct_change(glob_B.get(p), glob_L.get(p))
            uv_s = tm.unit_value(glob_L.get(p), glob_kg.get(p))
            flags = []
            r = rca_by.get(p)
            if r is not None and r > 1:
                flags.append("revealed_advantage")
            if g_sup is not None and g_mkt is not None and g_sup > g_mkt:
                flags.append("growing_faster_than_this_market")
            if uv_s is not None and uv_m is not None and uv_s < uv_m:
                flags.append("lower_unit_value_than_this_market")
            g = _geo(geo, p, m)
            if g and g.get("dist") is not None and g["dist"] < 8000:
                flags.append("within_8000km")
            if len(flags) >= 2:
                cands.append({"iso3": p, "share_in_market_pct": round(share_here, 3), "global_sales_usd": round(glob_L[p]), "global_growth_pct": None if g_sup is None else round(g_sup, 2),
                              "rca": None if r is None else round(r, 3), "unit_value": None if uv_s is None else round(uv_s, 4),
                              "distance_km": None if not g or g.get("dist") is None else round(g["dist"]), "flags": flags})
        cands.sort(key=lambda c: (-len(c["flags"]), -c["global_sales_usd"]))
        rows.append({"iso3": m, "value_usd": round(val_L), "growth_pct": None if g_mkt is None else round(g_mkt, 2),
                     "weight_growth_pct": None if kg_B is None else (None if tm.pct_change(kg_B, kg_L) is None else round(tm.pct_change(kg_B, kg_L), 2)),
                     "unit_value": None if uv_m is None else round(uv_m, 4), "supplier_count": len([1 for v in s_L.values() if v > 0]),
                     "hhi": None if hh is None else round(hh, 4), "effective_suppliers": None if not hh else round(1.0 / hh, 1),
                     "top3_share_pct": round(sum(sorted(sh.values(), reverse=True)[:3]), 2) if sh else None, "candidates": cands[:MAX_CANDIDATES]})
    return {"markets": rows, "limits": LIMITS, "kind": "screening signal derived from reported trade, not a forecast",
            "global_unit_value": None if uv_mkt_global is None else round(uv_mkt_global, 4)}


def armington_descriptive(sup_L: dict, sup_B: dict, kg_L: dict, kg_B: dict) -> dict:
    """Descriptive supplier differentiation. Relates each leading supplier's unit-value change (relative to the whole market) to its
    share change. The rank correlation is a pattern in the data, not an elasticity: it ignores quality, product mix and prices paid
    by each buyer, and no identification design is applied."""
    tot_L, tot_B = sum(sup_L.values()), sum(sup_B.values())
    uv_all_L = tm.unit_value(tot_L, sum(kg_L.values()))
    uv_all_B = tm.unit_value(tot_B, sum(kg_B.values()))
    mkt_uv_chg = tm.pct_change(uv_all_B, uv_all_L)
    leaders = [p for p, _ in sorted(sup_L.items(), key=lambda kv: -kv[1])[:TOP_SUPPLIERS]]
    rel, dsh, rows = [], [], []
    for p in leaders:
        uvL, uvB = tm.unit_value(sup_L.get(p), kg_L.get(p)), tm.unit_value(sup_B.get(p), kg_B.get(p))
        c = tm.pct_change(uvB, uvL)
        rel_c = None if c is None or mkt_uv_chg is None else c - mkt_uv_chg
        sh_c = None
        if tot_L > 0 and tot_B > 0 and p in sup_B:
            sh_c = 100.0 * sup_L[p] / tot_L - 100.0 * sup_B[p] / tot_B
        rel.append(rel_c)
        dsh.append(sh_c)
        rows.append({"iso3": p, "unit_value": None if uvL is None else round(uvL, 4),
                     "unit_value_vs_market_pct": None if uvL is None or uv_all_L in (None, 0) else round(100.0 * (uvL / uv_all_L - 1.0), 1),
                     "relative_unit_value_change_pp": None if rel_c is None else round(rel_c, 2), "share_change_pp": None if sh_c is None else round(sh_c, 3)})
    uvs = [r["unit_value"] for r in rows if r["unit_value"] is not None]
    cv = None
    if len(uvs) >= 3:
        mean = sum(uvs) / len(uvs)
        cv = (sum((u - mean) ** 2 for u in uvs) / len(uvs)) ** 0.5 / mean if mean else None
    hh = tm.hhi(sup_L)
    rho = _spearman(rel, dsh)
    return {"effective_suppliers": None if not hh else round(1.0 / hh, 1), "unit_value_dispersion_cv": None if cv is None else round(cv, 3),
            "rank_corr_unit_value_change_vs_share_change": None if rho is None else round(rho, 3), "suppliers": rows,
            "structural_estimate": "unavailable",
            "note": ("Descriptive only. Estimating how easily buyers switch between origins (Armington elasticities) needs a long price and quantity panel by buyer and "
                     "an identification strategy; neither is available, so no elasticity is shown.")}
