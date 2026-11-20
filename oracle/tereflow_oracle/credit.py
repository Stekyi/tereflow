"""Sectoral credit intelligence: fetch, store, validate and analyse outstanding bank credit by sector.

Sources
  * Bank of Ghana DataWarehousePro guest API (national, sector by sector).
  * IMF Monetary and Financial Statistics, Other Depository Corporations, over SDMX (fallback: broad borrower sectors).

Rules that this module enforces and the tests check
  * A missing value is never zero. A reported zero is kept as a zero and flagged when it follows a long non-zero history.
  * The source frequency is kept. Aggregation to quarters or years is done at display time, never at ingestion.
  * The change in a stock is a NET change in outstanding credit. It is not gross lending or repayment, and it is never labelled so.
  * Sector shares are shown only for periods where the sectors add up to the reported total.
  * National and IMF observations are separate series with separate provenance and are never merged into one.
  * No AI and no guessing: every step is a fixed rule over the data.
No Oracle is needed to import this module; the database functions take a connection.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import time
import uuid
import xml.etree.ElementTree as ET
from calendar import monthrange
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "templates" / "credit_config.json"
UA = {"User-Agent": "Mozilla/5.0 (Tereflow credit pipeline)"}
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
FREQ_ORDER = ["M", "Q", "A"]


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or CONFIG_PATH).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------------------------------------------

def period_end(period: str) -> str:
    """Last calendar day of a period key: 2026-04, 2026-Q2 or 2026."""
    if re.fullmatch(r"\d{4}-\d{2}", period):
        y, m = int(period[:4]), int(period[5:7])
        return f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
    q = re.fullmatch(r"(\d{4})-Q([1-4])", period)
    if q:
        y, m = int(q.group(1)), int(q.group(2)) * 3
        return f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
    if re.fullmatch(r"\d{4}", period):
        return f"{period}-12-31"
    raise ValueError(f"unrecognised period {period!r}")


def prev_period(period: str) -> str:
    """The period immediately before this one, at the same frequency."""
    if re.fullmatch(r"\d{4}-\d{2}", period):
        y, m = int(period[:4]), int(period[5:7])
        return f"{y - 1:04d}-12" if m == 1 else f"{y:04d}-{m - 1:02d}"
    q = re.fullmatch(r"(\d{4})-Q([1-4])", period)
    if q:
        y, n = int(q.group(1)), int(q.group(2))
        return f"{y - 1:04d}-Q4" if n == 1 else f"{y:04d}-Q{n - 1}"
    return f"{int(period) - 1:04d}"


def freq_of_period(period: str) -> str:
    if re.fullmatch(r"\d{4}-\d{2}", period):
        return "M"
    if re.fullmatch(r"\d{4}-Q[1-4]", period):
        return "Q"
    return "A"


def bog_periods(labels: list[str]) -> list[str]:
    """'Jan-99' style labels to 2000-style keys. Two-digit years from 70 up are 19xx. Labels must run forward in time."""
    out: list[str] = []
    for lab in labels:
        m = re.fullmatch(r"([A-Za-z]{3})-(\d{2})", lab.strip())
        if not m or m.group(1).title() not in MONTHS:
            raise ValueError(f"unrecognised period label {lab!r}")
        yy = int(m.group(2))
        year = 1900 + yy if yy >= 70 else 2000 + yy
        out.append(f"{year:04d}-{MONTHS[m.group(1).title()]:02d}")
    if any(b <= a for a, b in zip(out, out[1:])):
        raise ValueError("period labels are not in increasing order (duplicate, unsorted or wrapped years)")
    return out


def imf_period(tp: str) -> str:
    """IMF TIME_PERIOD: 2001-M12, 2001-Q4, 2001 (also 2001-12 is accepted)."""
    m = re.fullmatch(r"(\d{4})-M(\d{2})", tp)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    if re.fullmatch(r"\d{4}-Q[1-4]", tp) or re.fullmatch(r"\d{4}", tp) or re.fullmatch(r"\d{4}-\d{2}", tp):
        return tp
    raise ValueError(f"unrecognised IMF period {tp!r}")


# ---------------------------------------------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------------------------------------------

@dataclass
class Obs:
    period: str
    raw_label: str
    raw_value: str | None  # exactly as published; None when the source gave no value
    value: Decimal | None  # published value, parsed; None means missing (never zero)


@dataclass
class Parsed:
    meta: dict
    obs: list[Obs]
    problems: list[str] = field(default_factory=list)
    duplicates: int = 0
    missing: int = 0


def _to_decimal(s) -> tuple[Decimal | None, str | None]:
    if s is None or str(s).strip() == "":
        return None, None
    try:
        d = Decimal(str(s).strip())
    except InvalidOperation:
        return None, f"not a number: {str(s)[:30]!r}"
    if not d.is_finite():
        return None, f"not finite: {str(s)[:30]!r}"
    return d, None


def parse_bog(payload: dict, expected_mnemonic: str | None = None) -> Parsed:
    """Validate and normalise one Bank of Ghana DataWarehousePro series response."""
    problems: list[str] = []
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    need = ["mnemonic", "name_of_series", "unit_of_measure", "frequency", "data"]
    miss = [k for k in need if k not in payload]
    if miss:
        raise ValueError(f"response lacks {', '.join(miss)}")
    if expected_mnemonic and payload["mnemonic"] != expected_mnemonic:
        raise ValueError(f"asked for {expected_mnemonic} but the source returned {payload['mnemonic']}")
    if not isinstance(payload["data"], list) or not payload["data"]:
        raise ValueError("the series has no observations")
    freq = str(payload["frequency"]).strip()[:1].upper()
    if freq not in FREQ_ORDER:
        raise ValueError(f"unsupported frequency {payload['frequency']!r}")
    if freq != "M":
        raise ValueError("this reader supports the monthly Bank of Ghana format; add a reader before enabling other frequencies")
    labels = [str(o.get("description", "")) for o in payload["data"]]
    periods = bog_periods(labels)
    obs: list[Obs] = []
    missing = 0
    for p, o, lab in zip(periods, payload["data"], labels):
        raw = o.get("value")
        val, err = _to_decimal(raw)
        if err:
            problems.append(f"{lab}: {err}")
        if val is None:
            missing += 1
        obs.append(Obs(p, lab, None if raw is None or str(raw).strip() == "" else str(raw).strip(), val))
    meta = {
        "series_name": payload["name_of_series"],
        "data_family": payload.get("data_family"),
        "unit_label": payload["unit_of_measure"],
        "frequency": freq,
        "databank": payload.get("databank"),
        "source_note": payload.get("notes") or None,
        "first_observation": payload.get("first_observation"),
        "data_source": payload.get("data_source"),
    }
    return Parsed(meta, obs, problems, 0, missing)


def parse_imf_data(xml_text: str, expected: dict | None = None) -> Parsed:
    """Validate and normalise one IMF SDMX structure-specific data message holding exactly one series."""
    root = ET.fromstring(xml_text)
    series = [e for e in root.iter() if e.tag.split("}")[-1] == "Series"]
    if not series:
        raise ValueError("the IMF returned no series for this key")
    if len(series) > 1:
        raise ValueError("expected one series but the IMF returned several; the key is too broad")
    s = series[0]
    attrs = dict(s.attrib)
    for k, v in (expected or {}).items():
        if attrs.get(k) != v:
            raise ValueError(f"asked for {k}={v} but the IMF returned {attrs.get(k)}")
    freq = attrs.get("FREQUENCY", "")
    if freq not in FREQ_ORDER:
        raise ValueError(f"unsupported frequency {freq!r}")
    obs: list[Obs] = []
    problems: list[str] = []
    missing = 0
    seen: set[str] = set()
    dups = 0
    for o in s:
        if o.tag.split("}")[-1] != "Obs":
            continue
        tp = o.attrib.get("TIME_PERIOD", "")
        try:
            p = imf_period(tp)
        except ValueError as e:
            problems.append(str(e))
            continue
        if p in seen:
            dups += 1
        seen.add(p)
        raw = o.attrib.get("OBS_VALUE")
        val, err = _to_decimal(raw)
        if err:
            problems.append(f"{tp}: {err}")
        if val is None:
            missing += 1
        obs.append(Obs(p, tp, None if raw is None or str(raw).strip() == "" else str(raw).strip(), val))
    if not obs:
        raise ValueError("the series has no observations")
    meta = {"attributes": attrs, "frequency": freq, "scale_attribute": attrs.get("SCALE")}
    return Parsed(meta, obs, problems, dups, missing)


def parse_imf_discovery(xml_text: str) -> list[dict]:
    """Series that exist for a country, from a wildcard query: INDICATOR, TYPE_OF_TRANSFORMATION and FREQUENCY of each."""
    root = ET.fromstring(xml_text)
    return [dict(e.attrib) for e in root.iter() if e.tag.split("}")[-1] == "Series"]


def parse_imf_codelist(xml_text: str) -> dict[str, dict]:
    """Code -> {name, description} from an SDMX codelist message."""
    root = ET.fromstring(xml_text)
    out: dict[str, dict] = {}
    for code in root.iter():
        if code.tag.split("}")[-1] != "Code":
            continue
        name = desc = ""
        for ch in code:
            t = ch.tag.split("}")[-1]
            if t == "Name" and not name:
                name = (ch.text or "").strip()
            elif t == "Description" and not desc:
                desc = (ch.text or "").strip()
        out[code.attrib.get("id", "")] = {"name": name, "description": desc}
    return out


def dedupe(obs: list[Obs]) -> list[Obs]:
    """One observation per period, the last one wins. Order is by period."""
    by: dict[str, Obs] = {}
    for o in obs:
        by[o.period] = o
    return [by[k] for k in sorted(by)]


def checksum(obs: list[Obs]) -> str:
    h = hashlib.sha256()
    for o in obs:
        h.update(f"{o.period}|{o.raw_value}\n".encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------------------------
# Observation diff (idempotent upsert, revisions kept)
# ---------------------------------------------------------------------------------------------------------------

def diff_obs(existing: dict[str, str | None], incoming: list[Obs]) -> tuple[list[Obs], list[tuple[Obs, str | None]], int]:
    """Split incoming into new, revised (with the old raw value) and unchanged (count). Re-running changes nothing."""
    new, revised, same = [], [], 0
    for o in incoming:
        if o.period not in existing:
            new.append(o)
        elif _norm(existing[o.period]) != _norm(o.raw_value):
            revised.append((o, existing[o.period]))
        else:
            same += 1
    return new, revised, same


def _norm(v: str | None) -> str | None:
    if v is None:
        return None
    try:
        return format(Decimal(v).normalize(), "f")
    except InvalidOperation:
        return v


# ---------------------------------------------------------------------------------------------------------------
# Measure classification
# ---------------------------------------------------------------------------------------------------------------

def stock_evidence(values: list[float]) -> dict:
    """Behavioural evidence for 'this is a stock'. A stock carries forward, so successive levels are close to each other;
    a flow resets each period. This is evidence, not proof, and the result is labelled 'inferred'."""
    v = [x for x in values if x is not None]
    if len(v) < 24:
        return {"enough_data": False, "n": len(v)}
    big = [i for i in range(1, len(v)) if v[i - 1] > 0]
    within = sum(1 for i in big if 0.5 <= v[i] / v[i - 1] <= 2.0)
    pct_close = 100.0 * within / max(1, len(big))
    ups = sum(1 for i in range(1, len(v)) if v[i] > v[i - 1])
    return {"enough_data": True, "n": len(v), "pct_months_within_half_to_double": round(pct_close, 1), "pct_rising": round(100.0 * ups / (len(v) - 1), 1)}


def classify_stock(ev: dict, min_match: float = 90.0) -> tuple[str, str]:
    """(measure_kind, note). Inference needs both a persistent level and enough history."""
    if not ev.get("enough_data"):
        return "unverified", "Too few observations to test whether this is a stock."
    if ev["pct_months_within_half_to_double"] >= min_match:
        return "stock", (f"Inferred stock: {ev['pct_months_within_half_to_double']}% of month-to-month moves stay within half to double the "
                         "previous level, which is how a carried-forward balance behaves. The source does not state it; confirm with the source.")
    return "unverified", (f"Behaviour does not clearly match a stock ({ev['pct_months_within_half_to_double']}% of moves within half to double). "
                          "Net changes are not calculated until it is confirmed.")


# ---------------------------------------------------------------------------------------------------------------
# Analysis: net change, percentage change, shares, ranks, data-quality flags
# ---------------------------------------------------------------------------------------------------------------

def additivity(total_obs: list[tuple[str, float]], components: list[list[tuple[str, float]]], tol_pct: float = 0.5) -> dict:
    """How often the components add up to the total. If a total behaves as a stock and its components add up to it
    exactly, the components are the same kind of measure: a flow cannot sum to a stock."""
    comp = [dict(c) for c in components]
    tot = dict(total_obs)
    checked = ok = 0
    for p, t in tot.items():
        parts = [c.get(p) for c in comp]
        if t and all(x is not None for x in parts):
            checked += 1
            if abs(sum(parts) - t) / abs(t) * 100.0 <= tol_pct:
                ok += 1
    return {"checked": checked, "ok": ok, "pct_ok": round(100.0 * ok / checked, 1) if checked else None}


def classify_family(total_kind: str, add: dict, min_ok_pct: float = 95.0) -> tuple[str, str]:
    """Kind for the components of a total, from the total's kind and how well they add up to it."""
    if total_kind != "stock":
        return "unverified", "The total is not established as a stock, so its components are not either."
    if add.get("pct_ok") is not None and add["checked"] >= 24 and add["pct_ok"] >= min_ok_pct:
        return "stock", (f"Inferred stock: the sectors add up to the total in {add['pct_ok']}% of {add['checked']} periods, "
                         "and the total behaves as a carried-forward balance. The source does not state it; confirm with the source.")
    return "unverified", "The sectors do not reliably add up to the total, so they are not treated as stocks until confirmed."


def _f(x) -> float | None:
    return None if x is None else float(x)


def derive(series: list[dict], thresholds: dict) -> dict[str, list[dict]]:
    """series: [{id, role, kind, freq, obs: [(period, value_in_millions)]}] for ONE source and ONE frequency.

    Returns {series_id: [row]} with stock, previous stock, net change, percentage change, share of total (only when the
    sectors add up to the total), ranks among sectors, and flags. Only stock series get net changes."""
    tol = float(thresholds.get("share_tolerance_pct", 0.5))
    jump = thresholds.get("jump_pct", {"M": 50, "Q": 75, "A": 150})
    by_id = {s["id"]: {p: v for p, v in s["obs"]} for s in series}
    sectors = [s for s in series if s["role"] in ("sector", "borrower_sector")]
    total = next((s for s in series if s["role"] == "total"), None)
    out: dict[str, list[dict]] = {}
    for s in series:
        rows = []
        vals = by_id[s["id"]]
        nonzero_seen = 0
        for p in sorted(vals):
            cur = vals[p]
            prev_key = prev_period(p)
            prev = vals.get(prev_key)
            row = {"period": p, "period_end": period_end(p), "stock": cur, "prev_period": prev_key if prev is not None else None,
                   "prev_stock": prev, "net_change": None, "pct_change": None, "share_pct": None,
                   "rank_stock": None, "rank_change": None, "rank_pct": None, "flag": None}
            flags = []
            if s["kind"] == "stock" and prev is not None:
                row["net_change"] = cur - prev
                if prev > 0:
                    row["pct_change"] = (cur - prev) / prev * 100.0
                    lim = float(jump.get(s["freq"], 50))
                    if abs(row["pct_change"]) > lim:
                        flags.append(f"jump: {row['pct_change']:+.0f}% in one period, check for a reclassification or unit change")
                else:
                    flags.append("previous stock was zero, so no percentage change")
            elif s["kind"] == "stock" and prev is None and rows:
                flags.append("previous period missing: no change calculated across the gap")
            if cur == 0 and nonzero_seen >= 24:
                flags.append("zero after a long non-zero history")
            if cur != 0:
                nonzero_seen += 1
            row["flag"] = "; ".join(flags) if flags else None
            rows.append(row)
        out[s["id"]] = rows
    # shares
    if total and sectors:
        tot = by_id[total["id"]]
        for p in sorted(tot):
            parts = [by_id[s["id"]].get(p) for s in sectors]
            if tot[p] and all(x is not None for x in parts):
                gap = abs(sum(parts) - tot[p]) / abs(tot[p]) * 100.0
                if gap <= tol:
                    for s in sectors:
                        for r in out[s["id"]]:
                            if r["period"] == p:
                                r["share_pct"] = by_id[s["id"]][p] / tot[p] * 100.0
    # ranks among sectors, period by period
    periods = sorted({r["period"] for s in sectors for r in out[s["id"]]})
    idx = {s["id"]: {r["period"]: r for r in out[s["id"]]} for s in sectors}
    for p in periods:
        present = [s["id"] for s in sectors if p in idx[s["id"]]]
        for key, col in (("stock", "rank_stock"), ("net_change", "rank_change"), ("pct_change", "rank_pct")):
            ranked = [sid for sid in present if idx[sid][p][key] is not None]
            ranked.sort(key=lambda sid: -idx[sid][p][key])
            for n, sid in enumerate(ranked, 1):
                idx[sid][p][col] = n
    return out


def common_period(series: list[dict]) -> str | None:
    """Latest period at which every sector series has an observation. None if there is none."""
    sec = [s for s in series if s["role"] in ("sector", "borrower_sector")]
    if not sec:
        return None
    sets = [{p for p, _ in s["obs"]} for s in sec]
    common = set.intersection(*sets) if sets else set()
    return max(common) if common else None


def zero_run_flag(obs: list[tuple[str, float]]) -> dict | None:
    """Series-level flag: a long non-zero history followed by a run of zeros."""
    vals = [v for _, v in obs]
    run = 0
    for v in reversed(vals):
        if v == 0:
            run += 1
        else:
            break
    if run >= 3 and len(vals) - run >= 24:
        return {"since": obs[len(vals) - run][0], "zeros": run, "before": len(vals) - run}
    return None


def build_summary(country: str, source: dict, series: list[dict], derived: dict[str, list[dict]], thresholds: dict, generated_at: str) -> dict:
    """The payload the dashboard reads. Everything shown is a stored observation or a calculation from stored observations."""
    cp = common_period(series)
    sec = [s for s in series if s["role"] in ("sector", "borrower_sector")]
    total = next((s for s in series if s["role"] == "total"), None)
    rows = []
    for s in sec:
        d = derived[s["id"]]
        at = next((r for r in d if r["period"] == cp), None) if cp else None
        last = d[-1] if d else None
        shown = at or last
        if shown is None:
            continue
        rows.append({
            "series_id": s["id"], "sector_key": s["sector_key"], "sector_name": s["sector_name"], "role": s["role"],
            "frequency": s["freq"], "kind": s["kind"], "kind_basis": s["kind_basis"],
            "period": shown["period"], "period_end": shown["period_end"], "latest_own_period": last["period"],
            "at_common_period": at is not None,
            "stock": shown["stock"], "prev_stock": shown["prev_stock"], "net_change": shown["net_change"],
            "pct_change": shown["pct_change"], "share_pct": shown["share_pct"],
            "rank_stock": shown["rank_stock"], "rank_change": shown["rank_change"], "rank_pct": shown["rank_pct"],
            "first_period": d[0]["period"], "obs_count": len(d), "flag": shown["flag"], "flags_note": s.get("flags_note"),
        })
    rows.sort(key=lambda r: (r["rank_stock"] is None, r["rank_stock"] or 0, r["sector_name"]))
    total_block = {"valid": False, "reason": "No total series is configured for this source."}
    if total:
        td = {r["period"]: r for r in derived[total["id"]]}
        t = td.get(cp) if cp else None
        if t is None:
            total_block = {"valid": False, "reason": "No common reporting period across the sectors, so no total is shown."}
        else:
            sector_sum = sum(r["stock"] for r in rows if r["at_common_period"])
            gap = abs(sector_sum - t["stock"]) / abs(t["stock"]) * 100.0 if t["stock"] else None
            ok = gap is not None and gap <= float(thresholds.get("share_tolerance_pct", 0.5)) and len(rows) == len(sec)
            total_block = {"valid": ok, "period": t["period"], "stock": t["stock"], "prev_stock": t["prev_stock"], "net_change": t["net_change"],
                           "pct_change": t["pct_change"], "sectors_sum": sector_sum, "gap_pct": gap,
                           "reason": None if ok else "The sectors do not add up to the reported total at this period, so no complete total is claimed."}
            if ok:
                total_block["history"] = [[r["period"], r["stock"]] for r in derived[total["id"]]]
    movers = [r for r in rows if r["at_common_period"] and r["net_change"] is not None]
    gainers = sorted([r for r in movers if r["net_change"] > 0], key=lambda r: -r["net_change"])[:5]
    losers = sorted([r for r in movers if r["net_change"] < 0], key=lambda r: r["net_change"])[:5]
    return {
        "country": country, "source_key": source["source_key"], "source_name": source["source_name"], "unit": source["unit"],
        "frequency": series[0]["freq"] if series else None, "common_period": cp, "common_period_end": period_end(cp) if cp else None,
        "sector_count": len(rows), "sectors": rows, "total": total_block,
        "top_gainers": [r["series_id"] for r in gainers], "top_losers": [r["series_id"] for r in losers],
        "generated_at": generated_at,
    }


# ---------------------------------------------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------------------------------------------

def http_get(url: str, accept: str = "application/json", tries: int = 3, timeout: int = 120) -> str:
    import requests
    last = None
    for n in range(1, tries + 1):
        try:
            r = requests.get(url, headers={**UA, "Accept": accept}, timeout=timeout)
            if r.status_code == 200:
                return r.content.decode("utf-8", "replace")
            if r.status_code in (400, 401, 403, 404):
                raise RuntimeError(f"HTTP {r.status_code} from {url}")
            last = RuntimeError(f"HTTP {r.status_code} from {url}")
        except RuntimeError:
            raise
        except Exception as e:  # network trouble: retry
            last = e
        time.sleep(2 * n)
    raise RuntimeError(f"could not fetch {url}: {last}")


def bog_url(cfg: dict, mnemonic: str) -> str:
    return f"{cfg['bog']['base_url'].rstrip('/')}/{cfg['bog']['databank']}/{mnemonic}"


def imf_data_url(cfg: dict, country: str, indicator: str, freq: str, start: str | None = None) -> str:
    i = cfg["imf"]
    u = f"{i['base_url']}/data/{i['agency']},{i['dataflow']}/{country}.{indicator}.{i['transformation']}.{freq}"
    return u + (f"?startPeriod={start}" if start else "")


def imf_discovery_url(cfg: dict, country: str) -> str:
    i = cfg["imf"]
    return f"{i['base_url']}/data/{i['agency']},{i['dataflow']}/{country}.*.{i['transformation']}.*?lastNObservations=1"


def imf_codelist_url(cfg: dict) -> str:
    i = cfg["imf"]
    return f"{i['base_url']}/codelist/{i['agency']}/{i['indicator_codelist']}/latest"


def pick_frequency(available: set[str]) -> str | None:
    """Finest published frequency, because aggregation is done at display time and never at ingestion."""
    for f in FREQ_ORDER:
        if f in available:
            return f
    return None
