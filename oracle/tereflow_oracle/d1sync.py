"""Copy the Oracle product index into Cloudflare D1, as the fallback the Worker reads when ORDS is unreachable.

Run: python -m tereflow_oracle sync-index-d1 [--force]

Only a country whose lines changed is rewritten (a checksum is kept per country), which keeps D1 row writes low.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLS = ["reporter_iso3", "flow", "cmd_code", "level", "product_name", "year", "value_usd", "cagr_3y", "yoy_pct",
        "score", "confidence", "signal", "top_partner", "top_share_pct", "partner_count", "unit_value_usd_t", "years_available", "trend"]
BATCH = 60


def lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(float(v)) if isinstance(v, float) else str(v)
    return "'" + str(v).replace("'", "''") + "'"


def d1_query(sql: str) -> list:
    """Run SQL against the remote D1 database over the Cloudflare REST API, one request per statement group.

    Deliberately not `wrangler d1 execute --file`: for a large file that goes through the import path, which makes the whole
    database unavailable while it runs, and this database also holds the app's users and sessions."""
    import requests
    toml = (ROOT / "wrangler.toml").read_text()
    dbid = re.search(r'database_id\s*=\s*"([^"]+)"', toml).group(1)
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or re.search(r'account_id\s*=\s*"([^"]+)"', toml).group(1)
    r = requests.post(f"https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{dbid}/query",
                      headers={"Authorization": f"Bearer {os.environ.get('CLOUDFLARE_API_TOKEN')}"}, json={"sql": sql}, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(f"D1 query failed ({r.status_code}): {r.text[:600]}")
    body = r.json()
    if not body.get("success"):
        raise RuntimeError(f"D1 query failed: {str(body.get('errors'))[:600]}")
    return body["result"]


def remote_checksums() -> dict[str, str]:
    res = d1_query("SELECT reporter_iso3, checksum FROM product_index_meta")
    return {r["reporter_iso3"]: r["checksum"] for r in res[0]["results"]}


def sync(conn, force: bool = False) -> dict[str, int]:
    cur = conn.cursor()
    cur.execute("""SELECT reporter_iso3, flow, cmd_code, classification_level, product_name, name_lc, latest_year, value_usd, cagr_3y, yoy_pct,
                          score, confidence, signal, top_partner, top_share_pct, partner_count, unit_value_usd_t, years_available, trend
                   FROM tf_product_index ORDER BY reporter_iso3, flow, cmd_code""")
    by: dict[str, list[tuple]] = {}
    for row in cur:
        by.setdefault(row[0], []).append(tuple(row))
    cur.execute("""SELECT reporter_iso3, JSON_VALUE(payload, '$.overview.export_usd' RETURNING NUMBER),
                          JSON_VALUE(payload, '$.overview.import_usd' RETURNING NUMBER)
                   FROM tf_dashboard_cache WHERE kind = 'dashboard'""")
    totals = {r[0]: (r[1], r[2]) for r in cur}
    have = {} if force else remote_checksums()
    changed: dict[str, int] = {}
    stmts: list[str] = []
    for iso, rows in by.items():
        digest = hashlib.sha256(json.dumps(rows, default=str).encode()).hexdigest()
        if have.get(iso) == digest:
            continue
        stmts.append(f"DELETE FROM product_index WHERE reporter_iso3 = {lit(iso)};")
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            values = ",".join("(" + ",".join(lit(v) for k, v in enumerate(r) if k != 5) + ")" for r in chunk)
            stmts.append(f"INSERT INTO product_index ({','.join(COLS)}) VALUES {values};")
        latest = max(r[6] for r in rows)
        ex, im = totals.get(iso, (None, None))
        stmts.append(f"INSERT OR REPLACE INTO product_index_meta (reporter_iso3, latest_year, export_usd, import_usd, checksum, synced_at) "
                     f"VALUES ({lit(iso)}, {int(latest)}, {lit(ex)}, {lit(im)}, {lit(digest)}, datetime('now'));")
        changed[iso] = len(rows)
    gone = [c for c in have if c not in by]
    for iso in gone:
        stmts.append(f"DELETE FROM product_index WHERE reporter_iso3 = {lit(iso)};")
        stmts.append(f"DELETE FROM product_index_meta WHERE reporter_iso3 = {lit(iso)};")
    # One country at a time, each statement a separate request, so a failure leaves other countries untouched.
    for s in stmts:
        d1_query(s)
    return changed
