"""Command line: python -m tereflow_oracle <command>."""
from __future__ import annotations
import argparse
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

import requests

from .config import load_env, need
from . import db, analytics, opportunity, dashboard, ords
from .ingest import Ingestor, ISO3_M49, default_years, incremental_years
from .comtrade import Comtrade

ROOT = Path(__file__).resolve().parents[2]


def active_countries(conn) -> list[str]:
    cur = conn.cursor()
    # The admin switch (app_entities.is_active) is the only one; tf_country just holds the trade-side country list.
    cur.execute("""SELECT c.iso3 FROM tf_country c WHERE EXISTS
                   (SELECT 1 FROM app_entities e WHERE e.iso3 = c.iso3 AND e.kind = 'country' AND e.is_active = 1)
                   ORDER BY c.iso3""")
    return [r[0] for r in cur]


def cmd_sync_countries(conn, _a):
    """Copy active countries from the Cloudflare D1 registry into Oracle (read only on D1)."""
    toml = (ROOT / "wrangler.toml").read_text()
    dbid = re.search(r'database_id\s*=\s*"([^"]+)"', toml).group(1)
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or re.search(r'account_id\s*=\s*"([^"]+)"', toml).group(1)
    r = requests.post(f"https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{dbid}/query",
                      headers={"Authorization": f"Bearer {need('CLOUDFLARE_API_TOKEN')}"},
                      json={"sql": "SELECT iso3, name, slug, is_active FROM entities WHERE kind='country' AND iso3 IS NOT NULL"},
                      timeout=60)
    r.raise_for_status()
    rows = r.json()["result"][0]["results"]
    cur = conn.cursor()
    n = 0
    for x in rows:
        if x["iso3"] not in ISO3_M49:
            continue
        cur.execute("""MERGE INTO tf_country t USING (SELECT :i i FROM dual) s ON (t.iso3 = s.i)
          WHEN MATCHED THEN UPDATE SET name=:nm, slug=:sg, is_active=:ac, m49=:m, synced_at=SYSTIMESTAMP
          WHEN NOT MATCHED THEN INSERT (iso3, m49, name, slug, is_active) VALUES (:i, :m, :nm, :sg, :ac)""",
                    dict(i=x["iso3"], nm=x["name"], sg=x["slug"], ac=int(x["is_active"] or 0), m=ISO3_M49[x["iso3"]]))
        n += 1
    conn.commit()
    print(f"synced {n} countries from D1")


def cmd_create_app_user(conn, _a):
    """Create the least-privilege application login and store its password in .env."""
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM all_users WHERE username = 'TEREFLOW_APP'")
    if cur.fetchone()[0]:
        print("TEREFLOW_APP already exists")
        return
    pw = "Tf" + secrets.token_urlsafe(18).replace("-", "x").replace("_", "y") + "#9"
    cur.execute(f'CREATE USER tereflow_app IDENTIFIED BY "{pw}" QUOTA UNLIMITED ON DATA')
    cur.execute("GRANT CREATE SESSION TO tereflow_app")
    for obj in ("tf_country", "tf_ingest_run", "tf_comtrade_availability", "tf_ingest_state", "tf_ingest_error",
                "tf_trade_facts", "tf_trade_stage", "tf_product_metrics", "tf_opportunity", "tf_dashboard_cache"):
        cur.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {obj} TO tereflow_app")
    for v in ("v_sandbox_product_totals", "v_market_share", "v_world_reconciliation"):
        cur.execute(f"GRANT SELECT ON {v} TO tereflow_app")
    envf = ROOT / ".env"
    envf.write_text(envf.read_text().rstrip("\n") + f"\nORACLE_APP_USER=tereflow_app\nORACLE_APP_PASSWORD={pw}\n")
    print("created TEREFLOW_APP; credentials appended to .env")


def run_resilient(ing, a, countries, years, tries: int = 4):
    """Run an ingest, and if the database drops the connection (DPY-4011 and friends) reconnect and carry on.

    Finished country-years are skipped on a rerun, so retrying costs nothing already done."""
    import oracledb
    for attempt in range(1, tries + 1):
        try:
            return ing.run(countries, years)
        except oracledb.Error as e:
            if attempt == tries:
                raise
            print(f"database connection lost ({str(e)[:80]}); reconnecting, attempt {attempt + 1} of {tries}")
            time.sleep(15 * attempt)
            ing.conn = db.connect(app=a.app)


def cmd_ingest(conn, a):
    countries = [c.upper() for c in a.country] or active_countries(conn)
    if not countries:
        sys.exit("No active countries in Oracle. Run sync-countries or pass --country.")
    client = Comtrade(pace_s=float(os.environ.get("TEREFLOW_CALL_PACE_MS", "1200")) / 1000)
    ing = Ingestor(conn, client, force=a.force, dry_run=a.dry_run)
    if a.incremental:
        # The closed base years rarely change, so a routine run only fills gaps in the base and then follows the current year.
        s = None
        for c in countries:
            yrs = incremental_years(conn, c, a.base_years)
            print(f"{c}: incremental years {yrs}")
            r = run_resilient(ing, a, [c], yrs)
            if s is None:
                s = r
            else:
                s.success += r.success; s.skipped += r.skipped; s.no_data += r.no_data
                s.failed += r.failed; s.rows += r.rows
                s.stopped_on_rate_limit = s.stopped_on_rate_limit or r.stopped_on_rate_limit
    else:
        s = run_resilient(ing, a, countries, a.years or default_years(a.years_back))
    print(f"run {s.run_id}: {s.status} success={s.success} skipped={s.skipped} no_data={s.no_data} failed={s.failed} rows={s.rows:,}")
    if not a.dry_run and s.status in ("SUCCESS", "PARTIAL") and not a.no_analytics:
        for c in countries:
            print(f"metrics {c}: {analytics.refresh_metrics(conn, c):,} products")
            if c in opportunity.CONFIG:
                print(f"opportunities {c}: {opportunity.refresh_opportunities(conn, c):,} scored")
            print(f"dashboard {c}: {dashboard.refresh_dashboard(conn, c)} payloads cached")
    sys.exit(0 if s.status in ("SUCCESS",) else 2)


def cmd_worldbank(conn, a):
    from . import worldbank
    countries = [c.upper() for c in a.country] or [r[0] for r in conn.cursor().execute(
        "SELECT iso3 FROM app_entities WHERE kind = 'country' AND is_active = 1 AND iso3 IS NOT NULL ORDER BY iso3")]
    n = worldbank.load(conn, countries, a.from_year, a.dry_run)
    print(f"{n:,} observations for {len(countries)} countries")


def cmd_forecast(conn, a):
    from . import forecast
    flows = ["X", "M"] if a.flow == "both" else [a.flow]
    if a.cmd == "forecast-run":
        print(f"{forecast.cmd_run(conn, flows):,} forecasts written")
        return
    for r in forecast.cmd_eval(conn, flows, Path(a.out) if Path(a.out).is_absolute() else ROOT / a.out):
        print(json.dumps(r) if "error" in r else f"{r['flow']}: AUC model {r['auc_model']} vs momentum {r['auc_momentum']}; top-10% precision {r['precision_top10_model']} vs {r['precision_top10_momentum']} (base {r['base_rate_test']})")


def cmd_ingest_monthly(conn, a):
    from . import monthly, national
    years = a.years or default_years(6)
    client = None
    for c in [x.upper() for x in a.country]:
        # The UK has its own monthly source; every other country comes from Comtrade.
        if c in national.registry() and hasattr(national.registry()[c], "fetch_monthly"):
            print(c, monthly.ingest_monthly(conn, c, years))
            continue
        client = client or Comtrade(pace_s=float(os.environ.get("TEREFLOW_CALL_PACE_MS", "1200")) / 1000)
        res = monthly.ingest_monthly_comtrade(conn, client, c, years)
        print(c, res)
        if res.get("stopped_on_rate_limit"):
            break


def cmd_ingest_tariffs(conn, a):
    from . import tariffs
    client = tariffs.Wits(max_calls=a.max_calls)
    products = a.products or ["180100", "080131", "151590", "090111", "100630", "120740", "100590", "071410", "151110"]
    years = a.years or [2021, 2022, 2023]
    for c in [x.upper() for x in a.reporter]:
        # A long slow run can outlive the database connection, so each reporter gets a fresh one.
        conn = db.connect(app=a.app)
        res = tariffs.load_tariffs(conn, client, c, products, years)
        print(c, res)
        if res.get("budget_used"):
            break


def cmd_build_kb(conn, a):
    from . import kb
    names = kb.load_names(conn)
    trade = kb.load_trade(conn, kb.C)
    sql = kb.to_sql(kb.C, names, trade)
    from pathlib import Path
    Path(a.out).write_text(sql, encoding="utf-8", newline="\n")
    counts: dict[str, int] = {}
    for r in kb.C:
        k = kb.assess(r, names, trade)["confidence"]
        counts[k] = counts.get(k, 0) + 1
    print(f"wrote {len(kb.C)} relationships to {a.out}: {counts}")


def cmd_analytics(conn, a):
    for c in [x.upper() for x in a.country] or active_countries(conn):
        print(f"metrics {c}: {analytics.refresh_metrics(conn, c):,} products")
        if c in opportunity.CONFIG:
            print(f"opportunities {c}: {opportunity.refresh_opportunities(conn, c):,} scored")
        print(f"dashboard {c}: {dashboard.refresh_dashboard(conn, c)} payloads cached")


def cmd_define_ords(conn, _a):
    """Create or refresh the ORDS modules and OAuth clients; write the Worker settings to .env."""
    ords.define_module(conn)
    client_id, secret = ords.define_security(conn)
    ords.define_app_module(conn)
    app_id, app_secret = ords.define_app_security(conn)
    envf = ROOT / ".env"
    text = envf.read_text()
    host = os.environ.get("ORACLE_ORDS_HOST", "qfrucfvqrp17bzk-tereflow.adb.us-ashburn-1.oraclecloudapps.com")
    for k, v in (("ORACLE_ORDS_URL", f"https://{host}/ords/admin"), ("ORACLE_CLIENT_ID", client_id), ("ORACLE_CLIENT_SECRET", secret),
                 ("ORACLE_APP_CLIENT_ID", app_id), ("ORACLE_APP_CLIENT_SECRET", app_secret)):
        if f"\n{k}=" not in "\n" + text:
            text = text.rstrip("\n") + f"\n{k}={v}\n"
    envf.write_text(text)
    print("ORDS modules and OAuth clients defined; ORACLE_ORDS_URL, ORACLE_CLIENT_ID/SECRET and ORACLE_APP_CLIENT_ID/SECRET are in .env")


def cmd_status(conn, _a):
    cur = conn.cursor()
    cur.execute("""SELECT reporter_iso3, year, flow, classification_level, status, records, retry_count, TO_CHAR(updated_at,'YYYY-MM-DD HH24:MI')
                   FROM tf_ingest_state ORDER BY reporter_iso3, year DESC, flow""")
    for r in cur:
        print(*r, sep="\t")


def cmd_check(conn, _a):
    cur = conn.cursor()
    cur.execute("SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'")
    print(cur.fetchone()[0])


def main(argv=None):
    load_env()
    p = argparse.ArgumentParser(prog="tereflow_oracle")
    p.add_argument("--app", action="store_true", help="use the least-privilege app login")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("migrate", "sync-countries", "create-app-user", "status", "check", "define-ords"):
        sub.add_parser(name)
    i = sub.add_parser("ingest")
    i.add_argument("--country", nargs="*", default=[])
    i.add_argument("--years", nargs="*", type=int)
    i.add_argument("--years-back", type=int, default=int(os.environ.get("TEREFLOW_YEARS_BACK", "4")))
    i.add_argument("--force", action="store_true")
    i.add_argument("--dry-run", action="store_true")
    i.add_argument("--no-analytics", action="store_true")
    i.add_argument("--incremental", action="store_true", help="fill gaps in the base years, then only the current year")
    i.add_argument("--base-years", type=int, default=5)
    wbp = sub.add_parser("worldbank", help="load World Bank country indicators")
    wbp.add_argument("--country", nargs="*", default=[])
    wbp.add_argument("--from-year", type=int, default=2005)
    wbp.add_argument("--dry-run", action="store_true")
    for fname in ("forecast-eval", "forecast-run"):
        fp = sub.add_parser(fname)
        fp.add_argument("--flow", choices=["X", "M", "both"], default="both")
        fp.add_argument("--out", default="reports")
    mo = sub.add_parser("ingest-monthly")
    mo.add_argument("--country", nargs="+", required=True)
    mo.add_argument("--years", nargs="*", type=int)
    tf = sub.add_parser("ingest-tariffs")
    tf.add_argument("--reporter", nargs="+", required=True)
    tf.add_argument("--products", nargs="*")
    tf.add_argument("--years", nargs="*", type=int)
    tf.add_argument("--max-calls", type=int, default=60)
    kbp = sub.add_parser("build-kb")
    kbp.add_argument("--out", default="kb-seed.sql")
    an = sub.add_parser("analytics")
    an.add_argument("--country", nargs="*", default=[])
    ix = sub.add_parser("index-products")
    ix.add_argument("--country", nargs="*", default=[])
    sd = sub.add_parser("sync-index-d1")
    cs = sub.add_parser("create-app-schema")
    cs.add_argument("--prefix", default="app_")
    cs.add_argument("--drop", action="store_true")
    sub.add_parser("export-app-tables")
    cp = sub.add_parser("copy-app-data")
    cp.add_argument("--prefix", default="app_")
    sd.add_argument("--force", action="store_true")
    sd.add_argument("--max-writes", type=int, default=20000, help="refuse to write more than about this many D1 rows")
    a = p.parse_args(argv)
    conn = db.connect(app=a.app)
    if a.cmd == "migrate":
        print("applied:", db.migrate(conn) or "nothing new")
        return
    elif a.cmd == "create-app-schema":
        from . import appschema
        g = appschema.create(conn, prefix=a.prefix, drop=a.drop)
        print(f"created {len(g['tables'])} tables, {len(g['fks'])} foreign keys, {len(g['indexes'])} indexes with prefix {a.prefix}")
        return
    elif a.cmd == "copy-app-data":
        from . import appschema
        counts = appschema.copy_data(conn, prefix=a.prefix)
        print("copied:", {k: v for k, v in counts.items() if v})
        return
    elif a.cmd == "export-app-tables":
        from . import appschema
        (ROOT / "shared" / "app-tables.ts").write_text(appschema.export_tables_ts(), encoding="utf-8", newline="\n")
        print("wrote shared/app-tables.ts")
        return
    elif a.cmd == "sync-index-d1":
        from . import d1sync
        changed = d1sync.sync(conn, force=a.force, max_writes=a.max_writes)
        print("synced to D1:", changed or "nothing changed")
        return
    elif a.cmd == "index-products":
        n = 0
        for c in [x.upper() for x in a.country] or [r[0] for r in conn.cursor().execute("SELECT reporter_iso3 FROM tf_dashboard_cache WHERE kind = 'products' ORDER BY 1")]:
            feed = dashboard.read_cached(conn, c, "products")
            k = dashboard.refresh_product_index(conn, c, feed)
            print(f"index {c}: {k:,} lines")
            n += k
        print(f"{n:,} lines indexed")
        return
    {"sync-countries": cmd_sync_countries, "create-app-user": cmd_create_app_user, "ingest": cmd_ingest, "forecast-eval": cmd_forecast, "forecast-run": cmd_forecast, "worldbank": cmd_worldbank,
     "analytics": cmd_analytics, "ingest-monthly": cmd_ingest_monthly, "ingest-tariffs": cmd_ingest_tariffs, "build-kb": cmd_build_kb, "status": cmd_status, "check": cmd_check, "define-ords": cmd_define_ords}[a.cmd](conn, a)


if __name__ == "__main__":
    main()

