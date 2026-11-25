"""Pure trade-indicator formulas used by product intelligence. No database, no network.

Every function returns None rather than a made-up number when its inputs cannot support the result
(missing value, zero or negative denominator). Nothing here treats a missing value as zero.

Method versions are recorded with every stored result so a formula change never silently rewrites history.
"""
from __future__ import annotations

from typing import Optional

METHOD_VERSION = "pi-1"


def _num(v) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def pct_change(v0, v1) -> Optional[float]:
    """Percent change from v0 to v1. None when the start is missing, zero or negative, or the end is missing."""
    a, b = _num(v0), _num(v1)
    if a is None or b is None or a <= 0:
        return None
    return 100.0 * (b / a - 1.0)


def cagr_pct(v0, v1, years: float) -> Optional[float]:
    a, b = _num(v0), _num(v1)
    if a is None or b is None or a <= 0 or b < 0 or years <= 0:
        return None
    return 100.0 * ((b / a) ** (1.0 / years) - 1.0)


def shares(values: dict) -> dict:
    """Share of the total, in percent. Missing and negative entries are left out of both numerator and total."""
    clean = {k: _num(v) for k, v in values.items()}
    clean = {k: v for k, v in clean.items() if v is not None and v > 0}
    total = sum(clean.values())
    if total <= 0:
        return {}
    return {k: 100.0 * v / total for k, v in clean.items()}


def hhi(values: dict) -> Optional[float]:
    """Herfindahl-Hirschman index on a 0..1 scale (sum of squared shares). None with no positive values."""
    s = shares(values)
    if not s:
        return None
    return sum((p / 100.0) ** 2 for p in s.values())


def unit_value(value_usd, weight_kg) -> Optional[float]:
    """Trade value per kilogram. A proxy, not a transaction price: it moves with product mix and quality."""
    v, w = _num(value_usd), _num(weight_kg)
    if v is None or w is None or w <= 0 or v < 0:
        return None
    return v / w


def balassa_rca(x_cp, x_c, w_p, w) -> Optional[float]:
    """Balassa revealed comparative advantage: (x_cp / x_c) / (w_p / w).

    x_cp exporter c's exports of product p, x_c all of c's exports, w_p world exports of p, w all world exports.
    All four must be on the same universe and period."""
    a, b, c, d = _num(x_cp), _num(x_c), _num(w_p), _num(w)
    if None in (a, b, c, d) or b <= 0 or c <= 0 or d <= 0 or a < 0:
        return None
    return (a / b) / (c / d)


def rank_of(values: dict) -> dict:
    """1 = largest. Ties share the lower rank number. Missing values are not ranked."""
    clean = {k: _num(v) for k, v in values.items()}
    clean = {k: v for k, v in clean.items() if v is not None}
    order = sorted(clean.items(), key=lambda kv: -kv[1])
    out, prev, rank = {}, None, 0
    for i, (k, v) in enumerate(order, 1):
        if v != prev:
            rank = i
            prev = v
        out[k] = rank
    return out


def cms(cells: dict) -> dict:
    """Constant-market-share decomposition of one exporter's export change for one product across markets.

    cells maps a market key to (x0, x1, w0, w1):
      x0, x1  the exporter's exports to that market in the base and comparison period
      w0, w1  all suppliers' exports to that market (the market's total imports of the product), same periods

    Standard three-effect form with a separate new-market term:
      growth          X0 * r                          what the exporter would have gained by growing with the whole market
      distribution    sum x0_m * (r_m - r)            gain or loss from where its base-period sales were (markets that grew faster or slower)
      competitiveness sum x0_m * (g_m - r_m)          growth above or below each market's own growth; an accounting residual, not proof of productivity
      new_markets     sum x1_m over markets with x0_m = 0   sales in markets it did not serve in the base period
    where r is growth of the markets' total imports, r_m the growth of market m and g_m the exporter's growth there.
    The four effects add up to X1 - X0 exactly (checked and returned).

    Markets whose base-period total is missing or zero cannot define a growth rate; they are reported in `excluded`
    and kept out of every effect so the check still holds on the markets that remain."""
    base, kept, excluded = [], [], []
    for key, t in cells.items():
        x0, x1, w0, w1 = (_num(t[0]), _num(t[1]), _num(t[2]), _num(t[3]))
        if w0 is None or w1 is None or w0 <= 0 or w1 < 0:
            excluded.append(key)
            continue
        x0 = 0.0 if x0 is None else x0
        x1 = 0.0 if x1 is None else x1
        kept.append((key, x0, x1, w0, w1))
    w0_tot = sum(k[3] for k in kept)
    w1_tot = sum(k[4] for k in kept)
    if w0_tot <= 0:
        return {"ok": False, "reason": "No market has a usable base-period total.", "excluded": excluded}
    r = w1_tot / w0_tot - 1.0
    growth = dist = comp = new = 0.0
    x0_tot = x1_tot = 0.0
    per_market = []
    for key, x0, x1, w0, w1 in kept:
        x0_tot += x0
        x1_tot += x1
        r_m = w1 / w0 - 1.0
        if x0 > 0:
            g_m = x1 / x0 - 1.0
            g, d, c = x0 * r, x0 * (r_m - r), x0 * (g_m - r_m)
            growth += g
            dist += d
            comp += c
            per_market.append({"market": key, "x0": x0, "x1": x1, "growth": g, "distribution": d, "competitiveness": c, "new_market": 0.0,
                               "change": x1 - x0})
        else:
            new += x1
            if x1 > 0:
                per_market.append({"market": key, "x0": 0.0, "x1": x1, "growth": 0.0, "distribution": 0.0, "competitiveness": 0.0,
                                   "new_market": x1, "change": x1})
    total = x1_tot - x0_tot
    parts = growth + dist + comp + new
    return {
        "ok": True, "r_pct": 100.0 * r, "x0": x0_tot, "x1": x1_tot, "total_change": total,
        "growth": growth, "distribution": dist, "competitiveness": comp, "new_markets": new,
        "check_gap": total - parts, "excluded": excluded, "markets": per_market,
    }


def quantile(sorted_vals: list, q: float) -> Optional[float]:
    """Linear-interpolated quantile of an already sorted list."""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def bands(values: list, lo_q: float = 0.2, hi_q: float = 0.8) -> dict:
    """Cut-offs taken from the data itself: the 20th and 80th percentile of a cross-product distribution.
    Used instead of fixed thresholds, so a state such as 'strong growth' always means 'in the top fifth of products'."""
    v = sorted(x for x in (_num(i) for i in values) if x is not None)
    if len(v) < 20:
        return {"low": None, "high": None, "n": len(v)}
    return {"low": quantile(v, lo_q), "high": quantile(v, hi_q), "n": len(v)}


def band_state(value, cuts: dict) -> Optional[str]:
    v = _num(value)
    if v is None or cuts.get("low") is None:
        return None
    if v >= cuts["high"]:
        return "high"
    if v <= cuts["low"]:
        return "low"
    return "mid"
