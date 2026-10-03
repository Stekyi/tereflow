"""Command line: python -m tereflow_oracle <command>."""
from __future__ import annotations
import argparse
import os
import re
import secrets
import sys
from pathlib import Path

import requests

from .config import load_env, need
from . import db, analytics
from .ingest import Ingestor, ISO3_M49, default_years
from .comtrade import Comtrade

ROOT = Path(__file__).resolve().parents[2]


def active_countries(conn) -> list[str]:
    cur = conn.cursor()
    cur.execute("SELECT iso3 FROM tf_country WHERE is_active = 1 ORDER BY iso3")
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
                "tf_trade_facts", "tf_trade_stage", "tf_product_metrics"):
        cur.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {obj} TO tereflow_app")
    for v in ("v_sandbox_product_totals", "v_market_share", "v_world_reconciliation"):
        cur.execute(f"GRANT SELECT ON {v} TO tereflow_app")
    envf = ROOT / ".env"
    envf.write_text(envf.read_text().rstrip("\n") + f"\nORACLE_APP_USER=tereflow_app\nORACLE_APP_PASSWORD={pw}\n")
    print("created TEREFLOW_APP; credentials appended to .env")


def cmd_ingest(conn, a):
    countries = [c.upper() for c in a.country] or active_countries(conn)
    if not countries:
        sys.exit("No active countries in Oracle. Run sync-countries or pass --country.")
    years = a.years or default_years(a.years_back)
    client = Comtrade(pace_s=float(os.environ.get("TEREFLOW_CALL_PACE_MS", "1200")) / 1000)
    ing = Ingestor(conn, client, force=a.force, dry_run=a.dry_run)
    s = ing.run(countries, years)
    print(f"run {s.run_id}: {s.status} success={s.success} skipped={s.skipped} no_data={s.no_data} failed={s.failed} rows={s.rows:,}")
    if not a.dry_run and s.status in ("SUCCESS", "PARTIAL") and not a.no_analytics:
        for c in countries:
            print(f"metrics {c}: {analytics.refresh_metrics(conn, c):,} products")
    sys.exit(0 if s.status in ("SUCCESS",) else 2)


def cmd_analytics(conn, a):
    for c in [x.upper() for x in a.country] or active_countries(conn):
        print(f"metrics {c}: {analytics.refresh_metrics(conn, c):,} products")


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
    for name in ("migrate", "sync-countries", "create-app-user", "status", "check"):
        sub.add_parser(name)
    i = sub.add_parser("ingest")
    i.add_argument("--country", nargs="*", default=[])
    i.add_argument("--years", nargs="*", type=int)
    i.add_argument("--years-back", type=int, default=int(os.environ.get("TEREFLOW_YEARS_BACK", "4")))
    i.add_argument("--force", action="store_true")
    i.add_argument("--dry-run", action="store_true")
    i.add_argument("--no-analytics", action="store_true")
    an = sub.add_parser("analytics")
    an.add_argument("--country", nargs="*", default=[])
    a = p.parse_args(argv)
    conn = db.connect(app=a.app)
    if a.cmd == "migrate":
        print("applied:", db.migrate(conn) or "nothing new")
        return
    {"sync-countries": cmd_sync_countries, "create-app-user": cmd_create_app_user, "ingest": cmd_ingest,
     "analytics": cmd_analytics, "status": cmd_status, "check": cmd_check}[a.cmd](conn, a)


if __name__ == "__main__":
    main()

