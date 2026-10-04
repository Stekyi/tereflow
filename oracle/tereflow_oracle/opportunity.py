"""Deterministic metrics, opportunity scoring and blue oceans over Oracle trade facts.

A faithful port of worker/analytics/metrics.ts and worker/analytics/opportunities.ts
(same constants, same formulas, same wording) so results do not change when the data
source moves from D1 to Oracle. Deliberate differences are marked DIFF.
No clock, no network, no randomness: the same facts and config give the same output.
"""
from __future__ import annotations
import json
import math
from decimal import Decimal, ROUND_HALF_UP
from dataclasses import dataclass, field, replace
from pathlib import Path

NAMES = json.loads((Path(__file__).parent / "data" / "iso3_name.json").read_text(encoding="utf-8"))
CONFIG = json.loads((Path(__file__).parent / "data" / "country_config.json").read_text())

MEANINGFUL_BASE_USD = 100_000
VOLATILE_CV_PCT = 60
STABLE_BAND_PCT = 5
SIZE_CURVE = 0.35
MIN_MARKET_USD = 1_000_000
CONCENTRATED_HHI = 0.15
NAMEABLE_PARTNER_SHARE = 15
BLUE_MIN_SCORE = 45
FLOW_NAME = {"X": "export", "M": "import"}


@dataclass
class YearTotal:
    year: int
    value: float
    weight: float | None
    partners: dict[str, float]


@dataclass
class Metrics:
    reporter: str
    flow: str
    level: str
    code: str
    description: str | None
    latest_year: int
    earliest_year: int
    years_available: int
    value: float
    weight: float | None
    unit_value: float | None
    yoy: float | None
    cagr3: float | None
    cagr5: float | None
    trend: str
    volatility: float | None
    top_partner: str | None
    top_share: float | None
    hhi: float | None
    partner_count: int
    limitations: list[str] = field(default_factory=list)


def pct_change(a: float, b: float) -> float | None:
    if a <= 0:
        return None
    return (b - a) / a * 100


def cagr_over(years: list[YearTotal], span: int) -> float | None:
    if len(years) < 2:
        return None
    latest = years[-1]
    start = next((y for y in years if y.year == latest.year - span), None)
    if not start or start.value <= 0 or latest.value <= 0:
        return None
    return (math.pow(latest.value / start.value, 1 / span) - 1) * 100


def coeff_var(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))
    if abs(mean) < 1:
        return sd
    return abs(sd / mean) * 100


def trend_slope(years: list[YearTotal]) -> float | None:
    if len(years) < 2:
        return None
    n = len(years)
    mx = sum(y.year for y in years) / n
    my = sum(y.value for y in years) / n
    den = sum((y.year - mx) ** 2 for y in years)
    if den == 0:
        return None
    return sum((y.year - mx) * (y.value - my) for y in years) / den


def classify_trend(years, changes, vol, min_years, latest_value) -> str:
    if len(years) < min_years or not changes:
        return "insufficient_data"
    if latest_value < MEANINGFUL_BASE_USD:
        return "insufficient_data"
    if vol is not None and vol > VOLATILE_CV_PCT:
        return "volatile"
    slope = trend_slope(years)
    if slope is None:
        return "insufficient_data"
    mean = sum(y.value for y in years) / len(years)
    if mean <= 0:
        return "insufficient_data"
    rate = slope / mean * 100
    if abs(rate) <= STABLE_BAND_PCT:
        return "stable"
    return "growing" if rate > 0 else "declining"


def _span_limitation(years: list[YearTotal], span: int) -> str:
    word = {3: "three", 5: "five"}.get(span, str(span))
    if len(years) < 2:
        return f"A {word} year growth rate needs at least two years of data."
    latest, earliest = years[-1].year, years[0].year
    covered = latest - earliest
    return (f"No {word} year growth rate: the data spans {covered} year{'' if covered == 1 else 's'} "
            f"({earliest} to {latest}) and a {word} year rate needs a reading from {latest - span}.")


def compute_metrics(reporter: str, flow: str, level: str, code: str, desc: str | None,
                    years_in: list[YearTotal], min_years: int = 3) -> Metrics | None:
    years = sorted((y for y in years_in), key=lambda y: y.year)
    if not years:
        return None
    lim: list[str] = []
    latest, earliest = years[-1], years[0]
    unit = None
    if latest.weight is not None and latest.weight > 0:
        unit = latest.value / latest.weight
    else:
        lim.append("Import volume is not reported, so no unit value can be calculated.")
    prior = years[-2] if len(years) >= 2 else None
    yoy = pct_change(prior.value, latest.value) if prior else None
    if not prior:
        lim.append("Only one year of data, so year-on-year growth cannot be calculated.")
    c3, c5 = cagr_over(years, 3), cagr_over(years, 5)
    if c3 is None:
        lim.append(_span_limitation(years, 3))
    if c5 is None:
        lim.append(_span_limitation(years, 5))
    changes = [c for c in (pct_change(years[i - 1].value, years[i].value) for i in range(1, len(years))) if c is not None]
    vol = coeff_var(changes) if len(changes) >= 2 else None
    trend = classify_trend(years, changes, vol, min_years, latest.value)
    if trend == "insufficient_data":
        lim.append(f"At least {min_years} years of meaningful trade are needed to describe a trend.")
    ptotal = sum(latest.partners.values())
    shares = sorted(((p, v, v / ptotal * 100 if ptotal > 0 else 0) for p, v in latest.partners.items()),
                    key=lambda s: (-s[1], s[0]))
    top = shares[0] if shares else None
    hhi = sum((s[2] / 100) ** 2 for s in shares) if len(shares) >= 2 else None
    if len(shares) < 2:
        lim.append("Fewer than two partner countries reported, so supplier concentration cannot be assessed.")
    return Metrics(reporter, flow, level, code, desc, latest.year, earliest.year, len(years), latest.value,
                   latest.weight, unit, yoy, c3, c5, trend, vol, top[0] if top else None,
                   top[2] if top else None, hhi, len(shares), lim)


# ---------------------------------------------------------------- scoring
def size_score(value: float, ceiling: float) -> float:
    if not math.isfinite(value) or value <= 0 or ceiling <= 0:
        return 0.0
    return max(0.0, min(1.0, math.pow(value / ceiling, SIZE_CURVE)))


def growth_score(pct: float | None) -> float:
    if pct is None:
        return 0.5
    if pct <= -50:
        return 0.0
    if pct >= 50:
        return 1.0
    return (pct + 50) / 100


def stability_score(trend: str, vol: float | None) -> float:
    if trend == "insufficient_data":
        return 0.4
    if trend == "volatile":
        return 0.15
    if vol is None:
        return 0.5
    if vol <= 15:
        return 1.0
    if vol >= 80:
        return 0.1
    return 1 - (vol - 15) / 65 * 0.9


def concentration_score(hhi: float | None) -> float:
    if hhi is None:
        return 0.4
    return max(0.0, min(1.0, hhi))


def import_dependency_score(m: Metrics, ceiling: float) -> float:
    growing = 1.0 if m.trend == "growing" else 0.6 if m.trend == "stable" else 0.3
    return size_score(m.value, ceiling) * 0.6 + growing * 0.4


def score_one(m: Metrics, w: dict, ceiling: float) -> tuple[float, dict]:
    growth_in = m.cagr3 if m.cagr3 is not None else m.yoy
    b = {
        "market_size": size_score(m.value, ceiling),
        "growth": growth_score(growth_in),
        "import_dependency": import_dependency_score(m, ceiling),
        "stability": stability_score(m.trend, m.volatility),
        "supplier_concentration": concentration_score(m.hhi),
    }
    score = sum(b[k] * w[k] for k in b)
    return round_half_up(score * 1000) / 10, b


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def confidence_for(m: Metrics) -> tuple[str, list[str]]:
    reasons, pts = [], 0
    if m.years_available >= 5:
        pts += 2
        reasons.append(f"{m.years_available} years of history.")
    elif m.years_available >= 3:
        pts += 1
        reasons.append(f"{m.years_available} years of history, enough for a trend but not a long one.")
    else:
        reasons.append(f"Only {m.years_available} year{'' if m.years_available == 1 else 's'} of history.")
    # DIFF: the D1 version treated only HS6/HS10 as product level, so a genuine HS8
    # tariff line was described as "chapter level". All of HS6/HS8/HS10 are product level.
    if m.level in ("HS6", "HS8", "HS10"):
        pts += 2
        reasons.append(f"Product-level detail ({m.level}).")
    else:
        reasons.append(f"{m.level} chapter level, which describes a sector rather than a product.")
    if m.weight is not None:
        pts += 1
        reasons.append("Volume reported alongside value.")
    else:
        reasons.append("No volume reported.")
    if m.partner_count >= 3:
        pts += 1
        reasons.append(f"{m.partner_count} partner countries reported.")
    else:
        reasons.append(f"Only {m.partner_count} partner countr{'y' if m.partner_count == 1 else 'ies'} reported.")
    # Annual facts only, so the latest year is never a partial-month year here.
    return ("high" if pts >= 5 else "medium" if pts >= 3 else "low"), reasons


TREND_PHRASE = {"growing": "grown", "declining": "fallen", "stable": "held roughly level",
                "volatile": "moved unevenly", "insufficient_data": "not been measured over enough years to describe"}


def fx(v: float, n: int = 0) -> str:
    """JavaScript toFixed semantics (ties round up), so wording matches the TypeScript output."""
    q = Decimal(1).scaleb(-n)
    return str(Decimal(v).quantize(q, rounding=ROUND_HALF_UP))


def usd(v: float) -> str:
    a = abs(v)
    if a >= 1e9:
        return f"${fx(v / 1e9, 2)} billion"
    if a >= 1e6:
        return f"${fx(v / 1e6, 1)} million"
    if a >= 1e3:
        return f"${fx(v / 1e3)} thousand"
    return f"${fx(v)}"


def signed(v: float) -> str:
    return f"{'+' if v > 0 else ''}{fx(v, 1)}"


def classify_signal(m: Metrics) -> str:
    if m.flow == "X":
        return "export_growth"
    if m.hhi is not None and m.hhi >= 0.5:
        return "supplier_diversification"
    if m.hhi is None and m.partner_count <= 1:
        return "supplier_diversification"
    return "import_substitution"


def explain(m: Metrics, signal: str) -> tuple[str, list[str]]:
    ev, parts = [], []
    name = m.description or f"HS {m.code}"
    parts.append(f"{'Imports' if m.flow == 'M' else 'Exports'} of {name} reached {usd(m.value)} in {m.latest_year}.")
    ev.append(f"{m.latest_year} value: {usd(m.value)} ({fx(m.value)} USD)")
    if m.trend != "insufficient_data":
        parts.append(f"Value has {TREND_PHRASE[m.trend]} over {m.earliest_year} to {m.latest_year}.")
        ev.append(f"trend: {m.trend} across {m.years_available} years")
    if m.cagr3 is not None:
        parts.append(f"That is {signed(m.cagr3)}% a year over three years.")
        ev.append(f"3 year CAGR: {fx(m.cagr3, 1)}%")
    elif m.yoy is not None:
        parts.append(f"Year on year the change was {signed(m.yoy)}%.")
        ev.append(f"year on year: {fx(m.yoy, 1)}%")
    if m.top_partner and m.top_share is not None:
        parts.append(f"{m.top_partner} supplied {fx(m.top_share)}% of it" +
                     (f", of {m.partner_count} reporting partners." if m.partner_count > 1 else "."))
        ev.append(f"top partner: {m.top_partner} at {fx(m.top_share, 1)}%")
    if m.unit_value is not None:
        ev.append(f"unit value: ${fx(m.unit_value, 2)} per kg")
    if m.hhi is not None:
        ev.append(f"supplier concentration (HHI): {fx(m.hhi, 2)}")
    if signal == "import_substitution":
        parts.append("Sustained imports of a product at this scale are a potential import-substitution signal.")
    elif signal == "supplier_diversification":
        parts.append("Supply is concentrated in few countries, which is a potential opening for an alternative "
                     "supplier as well as a risk to buyers who depend on it.")
    else:
        parts.append("Export growth at this rate is worth examining alongside the destination markets.")
    parts.append("This is a signal rather than a recommendation: nothing here measures local production capacity, "
                 "input costs, or whether anybody can compete on it.")
    return " ".join(parts), ev


def exclusion_for(code: str, rules: list[dict]) -> str | None:
    if code and set(code) == {"0"}:
        return "A total line rather than a product."
    for r in rules:
        if any(code == c or code.startswith(c) for c in r.get("codes", [])):
            return r["reason"]
    return None


# --------------------------------------------------------------- database
YEARS_SQL = """
SELECT flow, classification_level, cmd_code, year,
       SUM(value_usd) AS v, SUM(CASE WHEN net_weight_kg > 0 THEN net_weight_kg END) AS w,
       MAX(cmd_desc) AS d
FROM tf_trade_facts
WHERE reporter_iso3 = :rep AND partner_iso3 <> 'WLD' AND value_usd IS NOT NULL
GROUP BY flow, classification_level, cmd_code, year
"""
PARTNERS_SQL = """
SELECT f.flow, f.classification_level, f.cmd_code, f.year, f.partner_iso3, f.value_usd
FROM tf_trade_facts f
JOIN (SELECT flow, classification_level, cmd_code, MAX(year) ly FROM tf_trade_facts
      WHERE reporter_iso3 = :rep AND partner_iso3 <> 'WLD' AND value_usd IS NOT NULL
      GROUP BY flow, classification_level, cmd_code) l
  ON l.flow = f.flow AND l.classification_level = f.classification_level
 AND l.cmd_code = f.cmd_code AND l.ly = f.year
WHERE f.reporter_iso3 = :rep AND f.partner_iso3 <> 'WLD' AND f.value_usd > 0
"""


def build(conn, reporter: str) -> list[dict]:
    cfg = CONFIG.get(reporter)
    if not cfg:
        raise RuntimeError(f"No scoring configuration for {reporter}; add it to data/country_config.json")
    cur = conn.cursor()
    series: dict[tuple, list[YearTotal]] = {}
    descs: dict[tuple, str | None] = {}
    cur.execute(YEARS_SQL, {"rep": reporter})
    for flow, lvl, code, year, v, w, d in cur:
        k = (flow, lvl, code)
        series.setdefault(k, []).append(YearTotal(int(year), float(v), None if w is None else float(w), {}))
        if d and (k not in descs or int(year) >= max(y.year for y in series[k])):
            descs[k] = d
    cur.execute(PARTNERS_SQL, {"rep": reporter})
    for flow, lvl, code, year, p, v in cur:
        for y in series.get((flow, lvl, code), []):
            if y.year == int(year):
                y.partners[p] = y.partners.get(p, 0.0) + float(v)
    metrics = [m for k, ys in series.items()
               if (m := compute_metrics(reporter, k[0], k[1], k[2], descs.get(k), ys))]
    if not metrics:
        return []
    ceiling = max(max(m.value for m in metrics), 1)
    out = []
    for m in sorted(metrics, key=lambda x: (-x.value, x.flow, x.code)):
        score, bd = score_one(m, cfg["scoring"], ceiling)
        sig = classify_signal(m)
        conf, reasons = confidence_for(m)
        text, ev = explain(replace(m, top_partner=NAMES.get(m.top_partner, m.top_partner)), sig)
        lim = list(m.limitations)
        if m.flow == "M":
            lim.append("Domestic production is not in this dataset, so the gap between local supply and demand cannot be established.")
        excl = exclusion_for(m.code, cfg["excluded"])
        below_floor = m.value < MIN_MARKET_USD or bool(m.code and set(m.code) == {"0"})
        if not excl and m.value < MIN_MARKET_USD:
            excl = (f"The whole national market is {usd(m.value)} a year, which is too small "
                    "to support a business however fast it is growing.")
        out.append({"m": m, "score": score, "breakdown": bd, "signal": sig, "confidence": conf,
                    "reasons": reasons, "text": text, "evidence": ev, "limitations": lim, "excluded": excl,
                    "below_floor": below_floor})
    out.sort(key=lambda r: -r["score"])
    return out


def refresh_opportunities(conn, reporter: str) -> int:
    rows = build(conn, reporter)
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM tf_opportunity WHERE reporter_iso3 = :1", [reporter])
        binds = []
        for r in rows:
            m: Metrics = r["m"]
            binds.append(dict(
                rep=reporter, fl=m.flow, code=m.code, lvl=m.level, name=(m.description or f"HS {m.code}")[:500],
                yr=m.latest_year, sc=r["score"], bd=json.dumps(r["breakdown"]), sig=r["signal"], conf=r["confidence"],
                cr=json.dumps(r["reasons"]), ex=r["text"], ev=json.dumps(r["evidence"]),
                li=json.dumps(r["limitations"]), isx=1 if r["excluded"] else 0, exr=r["excluded"], bf=1 if r["below_floor"] else 0,
                mj=json.dumps(m.__dict__)))
        cur.executemany("""INSERT INTO tf_opportunity (reporter_iso3, flow, cmd_code, classification_level, product_name,
            latest_year, opportunity_score, score_breakdown_json, signal_type, data_confidence, confidence_reasons_json,
            explanation, evidence_json, limitations_json, is_excluded, excluded_reason, below_floor, metrics_json)
            VALUES (:rep,:fl,:code,:lvl,:name,:yr,:sc,:bd,:sig,:conf,:cr,:ex,:ev,:li,:isx,:exr,:bf,:mj)""", binds)
        conn.commit()
        return len(binds)
    except Exception:
        conn.rollback()
        raise


def blue_oceans(conn, reporter: str, limit: int = 12, apply_config_exclusions: bool = True) -> list[dict]:
    """Blue oceans from structured metrics (the D1 version parsed numbers out of evidence prose).

    apply_config_exclusions=False drops only the size floor, so the caller can apply the admin
    classification (traditional chapters) itself. The cached feed served to the app uses that."""
    cur = conn.cursor()
    flag = "is_excluded" if apply_config_exclusions else "below_floor"
    cur.execute(f"""SELECT flow, cmd_code, classification_level, product_name, opportunity_score, signal_type,
                          score_breakdown_json, evidence_json, limitations_json, data_confidence, metrics_json
                   FROM tf_opportunity WHERE reporter_iso3 = :1 AND {flag} = 0 AND opportunity_score >= :2
                   ORDER BY opportunity_score DESC, cmd_code""", [reporter, BLUE_MIN_SCORE])
    found = []
    for fl, code, lvl, name, score, sig, bd, ev, li, conf, mj in cur:
        m = json.loads(mj.read() if hasattr(mj, "read") else mj)
        bd = json.loads(bd.read() if hasattr(bd, "read") else bd)
        ev = json.loads(ev.read() if hasattr(ev, "read") else ev)
        li = json.loads(li.read() if hasattr(li, "read") else li)
        hhi, share, cagr = m["hhi"], m["top_share"], m["cagr3"]
        kind = reason = None
        if sig == "import_substitution" and hhi is not None and hhi >= CONCENTRATED_HHI \
                and m["top_partner"] and share is not None and share >= NAMEABLE_PARTNER_SHARE:
            kind = "concentrated_supply"
            reason = (f"{NAMES.get(m['top_partner'], m['top_partner'])} supplies {fx(share)}% of what the country buys here, and supply overall "
                      "is concentrated. That is a single dependency for the buyer and room for a second source.")
        elif sig == "export_growth" and cagr is not None and cagr > 0 and bd.get("import_dependency", 1) < 0.5:
            kind = "growing_unserved"
            reason = (f"Demand here is growing at {fx(cagr)}% a year and the country holds only a small part of it. "
                      "The trade is moving and somebody other than this country is carrying it.")
        if not kind:
            continue
        found.append({
            "product_code": code, "product_name": name, "trade_flow": FLOW_NAME[fl], "classification_level": lvl,
            "opportunity_score": float(score), "kind": kind, "reason": reason, "evidence": ev,
            "limitations": ["Room in the data is not the same as room in the market. Nothing here measures whether a "
                            "newcomer can produce this, at what cost, or against what local competition.", *li],
            "top_partner": NAMES.get(m["top_partner"], m["top_partner"]), "partner_iso3": m["top_partner"], "top_partner_share_pct": share,
            "supplier_hhi": hhi, "value_usd": m["value"], "cagr_pct": cagr, "data_confidence": conf,
        })
        if len(found) >= limit:
            break
    return found
