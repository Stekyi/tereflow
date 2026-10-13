"""Monthly product totals for seasonality. Separate from the yearly ingest: it never touches
tf_trade_facts, and a year is replaced whole or not at all."""
from __future__ import annotations
from . import national


def ingest_monthly(conn, iso3: str, years: list[int], log=print) -> dict:
    prov = national.registry().get(iso3)
    if prov is None or not hasattr(prov, "fetch_monthly"):
        raise SystemExit(f"{iso3} has no monthly source yet (only HMRC for GBR)")
    from .ingest import Ingestor
    ing = Ingestor(conn, client=None, providers={iso3: prov})
    cur = conn.cursor()
    stored = skipped = 0
    for year in years:
        for flow in ("X", "M"):
            cur.execute("SELECT months FROM tf_monthly_state WHERE reporter_iso3=:1 AND flow=:2 AND year=:3", [iso3, flow, year])
            row = cur.fetchone()
            if row and row[0] == 12:
                log(f"{iso3} {year} {flow}: already stored (12 months)")
                skipped += 1
                continue
            rate = ing._usd_rate(prov, iso3, year, flow)
            if rate is None:
                log(f"{iso3} {year} {flow}: no USD basis yet, skipped")
                skipped += 1
                continue
            data = prov.fetch_monthly(year, flow, rate)
            months = sorted({m for (_c, m) in data})
            cur.execute("DELETE FROM tf_trade_monthly WHERE reporter_iso3=:1 AND flow=:2 AND year=:3", [iso3, flow, year])
            cur.executemany(
                """INSERT INTO tf_trade_monthly (reporter_iso3, flow, cmd_code, year, month, value_usd, net_weight_kg, source)
                   VALUES (:1,:2,:3,:4,:5,:6,:7,:8)""",
                [[iso3, flow, code, year, month, v, w, prov.key] for (code, month), (v, w) in data.items()])
            cur.execute("""MERGE INTO tf_monthly_state t USING (SELECT :r r, :f f, :y y FROM dual) s
                           ON (t.reporter_iso3 = s.r AND t.flow = s.f AND t.year = s.y)
                           WHEN MATCHED THEN UPDATE SET months = :m, rows_stored = :n, checked_at = SYSTIMESTAMP
                           WHEN NOT MATCHED THEN INSERT (reporter_iso3, flow, year, months, rows_stored) VALUES (s.r, s.f, s.y, :m, :n)""",
                        {"r": iso3, "f": flow, "y": year, "m": len(months), "n": len(data)})
            conn.commit()
            stored += len(data)
            log(f"{iso3} {year} {flow}: {len(data):,} product-months over {len(months)} month(s)")
    return {"stored": stored, "skipped": skipped}


MIN_RECHECK_DAYS = 7


def ingest_monthly_comtrade(conn, client, iso3: str, years: list[int], log=print) -> dict:
    """Monthly World totals per HS6 product from UN Comtrade, into the same table the UK uses.

    A year is replaced whole or not at all. A year with all twelve months is final and skipped; a partial
    year is looked at again only after a week. A year Comtrade cut short is not stored."""
    from .comtrade import RateLimited, ComtradeError
    from .ingest import ISO3_M49
    m49 = ISO3_M49.get(iso3)
    if m49 is None:
        raise SystemExit(f"{iso3} is not a known reporter")
    cur = conn.cursor()
    stored = skipped = failed = 0
    for year in years:
        for flow in ("X", "M"):
            cur.execute("""SELECT months, CAST(checked_at AS DATE) FROM tf_monthly_state
                           WHERE reporter_iso3=:1 AND flow=:2 AND year=:3""", [iso3, flow, year])
            row = cur.fetchone()
            if row and row[0] == 12:
                log(f"{iso3} {year} {flow}: already stored (12 months)")
                skipped += 1
                continue
            if row and row[1] is not None:
                from datetime import datetime, timedelta
                if datetime.now() - row[1] < timedelta(days=MIN_RECHECK_DAYS):
                    log(f"{iso3} {year} {flow}: {row[0]} month(s) checked recently, not asked again yet")
                    skipped += 1
                    continue
            try:
                data, truncated = client.fetch_monthly_world(m49, year, flow)
            except RateLimited as e:
                log(f"Comtrade rate limit (retry after {e.retry_after}s): stopping, nothing half-stored")
                return {"stored": stored, "skipped": skipped, "failed": failed, "stopped_on_rate_limit": True}
            except ComtradeError as e:
                log(f"{iso3} {year} {flow}: FAILED {str(e)[:120]}")
                failed += 1
                continue
            if truncated:
                log(f"{iso3} {year} {flow}: answer was cut short by the Comtrade cap, not stored")
                failed += 1
                continue
            months = sorted({m for (_c, m) in data})
            if not months:
                log(f"{iso3} {year} {flow}: no monthly data reported by Comtrade")
                skipped += 1
                continue
            cur.execute("DELETE FROM tf_trade_monthly WHERE reporter_iso3=:1 AND flow=:2 AND year=:3", [iso3, flow, year])
            cur.executemany(
                """INSERT INTO tf_trade_monthly (reporter_iso3, flow, cmd_code, year, month, value_usd, net_weight_kg, source)
                   VALUES (:1,:2,:3,:4,:5,:6,:7,'COMTRADE')""",
                [[iso3, flow, code, year, month, v, w] for (code, month), (v, w) in data.items()])
            cur.execute("""MERGE INTO tf_monthly_state t USING (SELECT :r r, :f f, :y y FROM dual) s
                           ON (t.reporter_iso3 = s.r AND t.flow = s.f AND t.year = s.y)
                           WHEN MATCHED THEN UPDATE SET months = :m, rows_stored = :n, checked_at = SYSTIMESTAMP
                           WHEN NOT MATCHED THEN INSERT (reporter_iso3, flow, year, months, rows_stored) VALUES (s.r, s.f, s.y, :m, :n)""",
                        {"r": iso3, "f": flow, "y": year, "m": len(months), "n": len(data)})
            conn.commit()
            stored += len(data)
            log(f"{iso3} {year} {flow}: {len(data):,} product-months over {len(months)} month(s)")
    return {"stored": stored, "skipped": skipped, "failed": failed, "stopped_on_rate_limit": False}
