"""World Bank loader: country indicators into app_indicator_observations.

    python -m tereflow_oracle worldbank [--country ISO3 ...] [--from-year 2005] [--dry-run]

Reads the public World Bank API (no key). Only indicators already defined in app_indicator_definitions are
written. Re-running replaces that source's rows for the country and indicator, so it is safe to repeat.
"""
from __future__ import annotations

import requests

API = "https://api.worldbank.org/v2/country/{iso3}/indicator/{wb}"
SOURCE = "World Bank WDI"
SOURCE_URL = "https://data.worldbank.org/indicator/{wb}"

# Tereflow indicator code -> World Bank indicator code.
MAP: dict[str, str] = {
    "POP_TOTAL": "SP.POP.TOTL",
    "POP_GROWTH": "SP.POP.GROW",
    "POP_URBAN_SHARE": "SP.URB.TOTL.IN.ZS",
    "POP_DENSITY": "EN.POP.DNST",
    "AGE_DEPENDENCY": "SP.POP.DPND",
    "LFP_RATE": "SL.TLF.CACT.ZS",
    "EMPLOYMENT_RATE": "SL.EMP.TOTL.SP.ZS",
    "UNEMPLOYMENT": "SL.UEM.TOTL.ZS",
    "UNEMPLOYMENT_YOUTH": "SL.UEM.1524.ZS",
    "LIFE_EXPECTANCY": "SP.DYN.LE00.IN",
    "BIRTH_RATE": "SP.DYN.CBRT.IN",
    "INTERNET_USERS": "IT.NET.USER.ZS",
    "MOBILE_PENETRATION": "IT.CEL.SETS.P2",
    "ELECTRICITY_ACCESS": "EG.ELC.ACCS.ZS",
    "GDP": "NY.GDP.MKTP.CD",
    "GDP_GROWTH": "NY.GDP.MKTP.KD.ZG",
    "GDP_PER_CAPITA": "NY.GDP.PCAP.CD",
    "GNI_PER_CAPITA": "NY.GNP.PCAP.CD",
    "GDP_AGRI_SHARE": "NV.AGR.TOTL.ZS",
    "GDP_INDUSTRY_SHARE": "NV.IND.TOTL.ZS",
    "GDP_SERVICES_SHARE": "NV.SRV.TOTL.ZS",
    "INFLATION": "FP.CPI.TOTL.ZG",
    "CPI": "FP.CPI.TOTL",
    "EXCHANGE_RATE": "PA.NUS.FCRF",
    "PPP_FACTOR": "PA.NUS.PPP",
    "CONSUMER_SPENDING": "NE.CON.PRVT.CD",
    "FDI_INFLOW": "BX.KLT.DINV.CD.WD",
    "FDI_OUTFLOW": "BM.KLT.DINV.CD.WD",
    "TRADE_OPENNESS": "NE.TRD.GNFS.ZS",
    "CURRENT_ACCOUNT": "BN.CAB.XOKA.GD.ZS",
    "PUBLIC_DEBT": "GC.DOD.TOTL.GD.ZS",
    "TAX_CORPORATE": "IC.TAX.TOTL.CP.ZS",
    "REG_TIME": "IC.REG.DURS",
    "CUSTOMS_TIME": "IC.EXP.TMBC",
    "LOGISTICS_PERFORMANCE": "LP.LPI.OVRL.XQ",
    "POVERTY_RATE": "SI.POV.NAHC",
    "GINI": "SI.POV.GINI",
    "LABOUR_PRODUCTIVITY": "SL.GDP.PCAP.EM.KD",
}


def fetch(iso3: str, wb: str, from_year: int, session=None) -> list[tuple[int, float]]:
    http = session or requests
    out: list[tuple[int, float]] = []
    page = 1
    while True:
        r = http.get(API.format(iso3=iso3, wb=wb), timeout=60,
                     params={"format": "json", "per_page": 200, "page": page, "date": f"{from_year}:2030"})
        if not r.ok:
            raise RuntimeError(f"World Bank HTTP {r.status_code} for {iso3} {wb}")
        body = r.json()
        if not isinstance(body, list) or len(body) < 2 or body[1] is None:
            return out          # unknown indicator or no data for this country
        meta, rows = body
        for row in rows:
            if row.get("value") is not None and str(row.get("date", "")).isdigit():
                out.append((int(row["date"]), float(row["value"])))
        if page >= int(meta.get("pages", 1)):
            return out
        page += 1


def load(conn, countries: list[str], from_year: int = 2005, dry_run: bool = False, log=print, session=None) -> int:
    cur = conn.cursor()
    cur.execute("SELECT code, name, category, unit FROM app_indicator_definitions WHERE is_active = 1")
    defs = {r[0]: r for r in cur}
    total = 0
    for iso in countries:
        cur.execute("SELECT id FROM app_entities WHERE kind = 'country' AND iso3 = :1", [iso])
        row = cur.fetchone()
        if not row:
            log(f"{iso}: not in the registry, skipped")
            continue
        ent = row[0]
        n = 0
        for code, wb in MAP.items():
            d = defs.get(code)
            if not d:
                continue
            try:
                obs = fetch(iso, wb, from_year, session)
            except Exception as e:
                log(f"{iso} {code}: {e}")
                continue
            if not obs or dry_run:
                n += len(obs)
                continue
            cur.execute("DELETE FROM app_indicator_observations WHERE entity_id = :1 AND indicator_code = :2 AND source_name = :3",
                        [ent, code, SOURCE])
            cur.executemany(
                """INSERT INTO app_indicator_observations
                   (entity_id, indicator_code, indicator_name, category, year, value, unit, currency, source_name, source_url, source_ref)
                   VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11)""",
                [[ent, code, d[1], d[2], y, v, d[3], "USD" if (d[3] or "").startswith(("currency", "usd")) else None,
                  SOURCE, SOURCE_URL.format(wb=wb), f"wb:{wb}"] for y, v in obs])
            n += len(obs)
        if not dry_run:
            conn.commit()
        log(f"{iso}: {n:,} observations{' (dry run)' if dry_run else ''}")
        total += n
    return total
