"""Read-only HTTP API over Oracle. Contract-compatible with the Worker's /api/trade/sandbox."""
from __future__ import annotations
import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import oracledb
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

import time

from . import db, opportunity, dashboard as dash
from .config import load_env, need

load_env()
app = FastAPI(title="Tereflow Oracle API", docs_url=None, redoc_url=None)
_pool = None
FLOW = {"X": "export", "M": "import"}
ISO3_M49 = json.loads((Path(__file__).parent / "data" / "iso3_m49.json").read_text())
NOTE = ("All comparisons use the primary country's stored partner-level trade facts from Oracle. "
        "Comparison countries do not need to be activated. No stored rows means no recorded transaction, "
        "and a value Comtrade did not report is not shown as zero. Each product total sums every partner for "
        "that product, year and flow. It is not the headline world row and not the sum of only the selected partners.")


def _init_session(conn, _tag):
    cur = conn.cursor()
    cur.execute("ALTER SESSION SET CURRENT_SCHEMA = ADMIN")
    cur.execute("ALTER SESSION DISABLE PARALLEL QUERY")


def pool():
    global _pool
    if _pool is None:
        wallet = os.environ.get("ORACLE_WALLET_PATH", "./Wallet_tereflow")
        if not os.path.isabs(wallet):
            wallet = str(Path(__file__).resolve().parents[2] / wallet)
        use_app = bool(os.environ.get("ORACLE_APP_USER"))
        _pool = oracledb.create_pool(
            user=need("ORACLE_APP_USER" if use_app else "ORACLE_DB_USER"),
            password=need("ORACLE_APP_PASSWORD" if use_app else "ORACLE_DB_PASSWORD"),
            dsn=os.environ.get("ORACLE_TNS_NAME", "tereflow_high"), config_dir=wallet,
            wallet_location=wallet, wallet_password=need("ORACLE_WALLET_PASSWORD"), min=1, max=4, session_callback=_init_session)
    return _pool


def auth(authorization: str | None = Header(default=None)):
    token = os.environ.get("ORACLE_API_TOKEN", "")
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not token or not hmac.compare_digest(given, token):
        raise HTTPException(401, "unauthorized")


class SandboxIn(BaseModel):
    primary: str = ""
    partners: list[str] = []


def sandbox_years() -> list[int]:
    last = datetime.now(timezone.utc).year - 1
    return [last - 4 + i for i in range(5)]


@app.get("/api/health")
def health(_=Depends(auth)):
    with pool().acquire() as c:
        cur = c.cursor()
        cur.execute("SELECT 1 FROM dual")
        cur.fetchone()
    return {"ok": True}


@app.post("/api/trade/sandbox")
def trade_sandbox(body: SandboxIn, _=Depends(auth)):
    primary_in = body.primary.strip()
    partners = list(dict.fromkeys(p.strip().upper() for p in body.partners if p.strip()))[:12]
    if not primary_in:
        raise HTTPException(400, "primary country is required")
    if not partners:
        raise HTTPException(400, "select at least one partner country")
    bad = [p for p in partners if p not in ISO3_M49]
    if bad:
        raise HTTPException(400, f"Unknown partner ISO3: {', '.join(bad)}")
    years = sandbox_years()
    with pool().acquire() as c:
        cur = c.cursor()
        cur.execute("SELECT iso3, name, slug FROM tf_country WHERE is_active=1 AND (LOWER(slug)=LOWER(:p) OR iso3=UPPER(:p))", {"p": primary_in})
        row = cur.fetchone()
        if not row:
            raise HTTPException(400, "Primary country is not an active country with an ISO3 code")
        p_iso, p_name, p_slug = row
        if p_iso in partners:
            raise HTTPException(400, "primary country cannot also be a partner")
        ybind = {f"y{i}": y for i, y in enumerate(years)}
        yin = ",".join(f":{k}" for k in ybind)
        pbind = {f"p{i}": p for i, p in enumerate(partners)}
        pin = ",".join(f":{k}" for k in pbind)

        cur.execute(f"""SELECT partner_iso3, year, flow, cmd_code, cmd_desc, classification_level, value_usd, net_weight_kg
                        FROM tf_trade_facts
                        WHERE reporter_iso3=:rep AND partner_iso3 IN ({pin}) AND year IN ({yin})
                        ORDER BY partner_iso3, year, flow, cmd_code""", {"rep": p_iso, **pbind, **ybind})
        facts = cur.fetchall()

        cur.execute(f"""SELECT t.year, t.flow, t.hs_code, t.all_partner_value_usd
                        FROM v_sandbox_product_totals t
                        WHERE t.reporter_iso3=:rep AND t.year IN ({yin}) AND t.all_partner_value_usd IS NOT NULL
                          AND EXISTS (SELECT 1 FROM tf_trade_facts f
                                      WHERE f.reporter_iso3=t.reporter_iso3 AND f.year=t.year AND f.flow=t.flow
                                        AND f.cmd_code=t.hs_code AND f.partner_iso3 IN ({pin}))""",
                    {"rep": p_iso, **pbind, **ybind})
        totals = cur.fetchall()

    by_partner: dict[str, list] = {p: [] for p in partners}
    for f in facts:
        by_partner[f[0]].append(f)

    out = []
    for iso in partners:
        rows = by_partner[iso]
        reported = [r for r in rows if r[6] is not None]
        unreported = len(rows) - len(reported)

        def total(year, flow):
            vals = [r[6] for r in rows if r[1] == year and r[2] == flow and r[6] is not None]
            return float(sum(vals)) if vals else None

        levels = sorted({int(r[5][2:]) for r in rows if r[5] and r[5][2:].isdigit()})
        out.append({
            "slug": iso.lower(), "name": iso, "iso3": iso,
            "classification_level": f"HS{levels[-1]}" if levels else None,
            "reporter_basis": "primary" if rows else "none",
            "years": years,
            "totals": [{"year": y, "export_usd": total(y, "X"), "import_usd": total(y, "M")} for y in years],
            "products": [{
                "hs_code": r[3], "product_name": r[4] or r[3], "flow": FLOW[r[2]], "year": int(r[1]),
                "value_usd": float(r[6]), "qty_kg": None if r[7] is None else float(r[7]),
                "classification_level": r[5], "reporter": p_iso, "partner_iso3": iso,
            } for r in reported],
            "unreported_rows": unreported,
        })
    return {
        "primary": {"slug": p_slug or p_iso.lower(), "name": p_name or p_iso, "iso3": p_iso},
        "partners": out, "years": years,
        "primary_product_totals": [{"year": int(t[0]), "flow": FLOW[t[1]], "hs_code": t[2], "value_usd": float(t[3])} for t in totals],
        "note": NOTE,
    }




@app.get("/api/blue-oceans/{iso3}")
def blue_oceans(iso3: str, limit: int = 12, _=Depends(auth)):
    """Blue oceans for a reporter, from structured metrics. Visibility and tier gating stay in the Worker."""
    iso3 = iso3.upper()
    with pool().acquire() as c:
        return {"reporter": iso3, "blue_oceans": opportunity.blue_oceans(c, iso3, max(1, min(limit, 50)))}


@app.get("/api/opportunities/{iso3}")
def opportunities(iso3: str, flow: str | None = None, include_excluded: bool = False, limit: int = 50, _=Depends(auth)):
    """Ranked opportunities with the evidence and metrics each score was computed from."""
    if flow is not None and flow not in ("X", "M"):
        raise HTTPException(400, "flow must be X or M")
    sql = """SELECT flow, cmd_code, classification_level, product_name, latest_year, opportunity_score, signal_type,
                    data_confidence, explanation, evidence_json, limitations_json, is_excluded, excluded_reason
             FROM tf_opportunity WHERE reporter_iso3 = :rep"""
    binds: dict = {"rep": iso3.upper()}
    if flow:
        sql += " AND flow = :fl"
        binds["fl"] = flow
    if not include_excluded:
        sql += " AND is_excluded = 0"
    sql += " ORDER BY opportunity_score DESC, cmd_code FETCH FIRST :n ROWS ONLY"
    binds["n"] = max(1, min(limit, 200))
    rd = lambda v: v.read() if hasattr(v, "read") else v
    with pool().acquire() as c:
        cur = c.cursor()
        cur.execute(sql, binds)
        rows = cur.fetchall()
    return {"reporter": iso3.upper(), "opportunities": [{
        "trade_flow": FLOW[r[0]], "product_code": r[1], "classification_level": r[2], "product_name": r[3],
        "latest_year": int(r[4]), "opportunity_score": float(r[5]), "signal_type": r[6], "data_confidence": r[7],
        "explanation": rd(r[8]), "evidence": json.loads(rd(r[9])), "limitations": json.loads(rd(r[10])),
        "is_excluded": bool(r[11]), "excluded_reason": r[12]} for r in rows]}


_cache: dict[tuple, tuple[float, object]] = {}
CACHE_TTL_S = 300


def cached(key: tuple, fn):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        return hit[1]
    val = fn()
    _cache[key] = (time.monotonic(), val)
    return val


@app.get("/api/dashboard/{iso3}")
def dashboard(iso3: str, _=Depends(auth)):
    """Trade-derived dashboard figures (overview, ranked products and partners, trend)."""
    iso3 = iso3.upper()

    def run():
        with pool().acquire() as c:
            return dash.read_cached(c, iso3, "dashboard") or dash.load_dashboard(c, iso3)
    d = cached(("dash", iso3), run)
    if d is None:
        raise HTTPException(404, f"No stored trade facts for {iso3}")
    return d


@app.get("/api/lines/{iso3}")
def lines(iso3: str, flow: str = "M", _=Depends(auth)):
    """Product lines for the latest year of a flow; the Worker groups them into families."""
    if flow not in ("X", "M"):
        raise HTTPException(400, "flow must be X or M")
    iso3 = iso3.upper()

    def run():
        with pool().acquire() as c:
            return dash.read_cached(c, iso3, f"lines_{flow}") or dash.load_lines(c, iso3, flow)
    d = cached(("lines", iso3, flow), run)
    if d is None:
        raise HTTPException(404, f"No stored trade facts for {iso3}")
    return d
