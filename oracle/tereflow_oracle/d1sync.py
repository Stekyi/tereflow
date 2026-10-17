"""Copy the Oracle product index into Cloudflare D1, as the fallback the Worker reads when ORDS is unreachable.

Run: python -m tereflow_oracle sync-index-d1 [--force] [--max-writes N]

D1's free plan allows 100,000 row writes a day for the WHOLE app (logins, sessions, admin changes and this copy share it),
and every index on a table multiplies the cost of each written row. So this writes only the lines that actually changed
(inserted, updated or deleted), never the whole table, and refuses to run when the change set would be large.
"""
from __future__ import annotations
import os
import re
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLS = ["reporter_iso3", "flow", "cmd_code", "level", "product_name", "year", "value_usd", "cagr_3y", "yoy_pct",
        "score", "confidence", "signal", "top_partner", "top_share_pct", "partner_count", "unit_value_usd_t", "years_available", "trend"]
KEY = 3
BATCH = 60
DELETE_BATCH = 100
# A row written to product_index costs several D1 row writes (rowid, primary key, any secondary index), so budget by this factor.
WRITE_COST_PER_ROW = 4
DEFAULT_MAX_WRITES = 20_000


def lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float, Decimal)):
        f = float(v)
        return str(int(f)) if f.is_integer() and abs(f) < 1e15 else repr(f)
    return "'" + str(v).replace("'", "''") + "'"


def norm(v):
    """The same value from Oracle and from D1 must compare equal: numbers to 6 decimals, text as it is."""
    if v is None:
        return None
    if isinstance(v, (int, float, Decimal)):
        return round(float(v), 6)
    return str(v)


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


def remote_lines() -> dict[tuple, tuple]:
    out: dict[tuple, tuple] = {}
    offset = 0
    while True:
        res = d1_query(f"SELECT {','.join(COLS)} FROM product_index ORDER BY reporter_iso3, flow, cmd_code LIMIT 5000 OFFSET {offset}")
        rows = res[0]["results"]
        for r in rows:
            vals = tuple(norm(r[c]) for c in COLS)
            out[vals[:KEY]] = vals
        if len(rows) < 5000:
            return out
        offset += 5000


def remote_meta() -> dict[str, tuple]:
    res = d1_query("SELECT reporter_iso3, latest_year, export_usd, import_usd FROM product_index_meta")
    return {r["reporter_iso3"]: (r["latest_year"], norm(r["export_usd"]), norm(r["import_usd"])) for r in res[0]["results"]}


def sync(conn, force: bool = False, max_writes: int = DEFAULT_MAX_WRITES) -> dict[str, int]:
    cur = conn.cursor()
    cur.execute("""SELECT reporter_iso3, flow, cmd_code, classification_level, product_name, latest_year, value_usd, cagr_3y, yoy_pct,
                          score, confidence, signal, top_partner, top_share_pct, partner_count, unit_value_usd_t, years_available, trend
                   FROM tf_product_index ORDER BY reporter_iso3, flow, cmd_code""")
    local = {}
    for row in cur:
        vals = tuple(norm(v) for v in row)
        local[vals[:KEY]] = tuple(row)
    cur.execute("""SELECT reporter_iso3, JSON_VALUE(payload, '$.overview.export_usd' RETURNING NUMBER),
                          JSON_VALUE(payload, '$.overview.import_usd' RETURNING NUMBER)
                   FROM tf_dashboard_cache WHERE kind = 'dashboard'""")
    totals = {r[0]: (r[1], r[2]) for r in cur}

    have = {} if force else remote_lines()
    to_write = [raw for key, raw in local.items() if have.get(key) != tuple(norm(v) for v in raw)]
    to_delete = [key for key in have if key not in local]
    estimated = (len(to_write) + len(to_delete)) * WRITE_COST_PER_ROW
    print(f"index lines: {len(local):,} in Oracle, {len(have):,} in D1; to write {len(to_write):,}, to delete {len(to_delete):,} "
          f"(about {estimated:,} D1 row writes)")
    if estimated > max_writes:
        raise RuntimeError(f"Refusing to write about {estimated:,} D1 rows (limit {max_writes:,}); D1's free plan allows 100,000 a day "
                           f"for the whole app. Re-run with --max-writes to allow it deliberately.")

    changed: dict[str, int] = {}
    update_cols = [c for c in COLS if c not in ("reporter_iso3", "flow", "cmd_code")]
    set_clause = ",".join(f"{c}=excluded.{c}" for c in update_cols)
    for i in range(0, len(to_write), BATCH):
        chunk = to_write[i:i + BATCH]
        values = ",".join("(" + ",".join(lit(v) for v in r) + ")" for r in chunk)
        d1_query(f"INSERT INTO product_index ({','.join(COLS)}) VALUES {values} "
                 f"ON CONFLICT(reporter_iso3, flow, cmd_code) DO UPDATE SET {set_clause};")
        for r in chunk:
            changed[r[0]] = changed.get(r[0], 0) + 1
    for i in range(0, len(to_delete), DELETE_BATCH):
        d1_query("".join(f"DELETE FROM product_index WHERE reporter_iso3={lit(k[0])} AND flow={lit(k[1])} AND cmd_code={lit(k[2])};"
                         for k in to_delete[i:i + DELETE_BATCH]))
        for k in to_delete[i:i + DELETE_BATCH]:
            changed[k[0]] = changed.get(k[0], 0) + 1

    meta = remote_meta()
    by_iso: dict[str, list] = {}
    for key, raw in local.items():
        by_iso.setdefault(key[0], []).append(raw)
    for iso, rows in by_iso.items():
        want = (max(r[5] for r in rows), norm(totals.get(iso, (None, None))[0]), norm(totals.get(iso, (None, None))[1]))
        if meta.get(iso) != want:
            ex, im = totals.get(iso, (None, None))
            d1_query(f"INSERT INTO product_index_meta (reporter_iso3, latest_year, export_usd, import_usd, synced_at) "
                     f"VALUES ({lit(iso)}, {int(want[0])}, {lit(ex)}, {lit(im)}, datetime('now')) "
                     f"ON CONFLICT(reporter_iso3) DO UPDATE SET latest_year=excluded.latest_year, export_usd=excluded.export_usd, "
                     f"import_usd=excluded.import_usd, synced_at=excluded.synced_at;")
    for iso in [c for c in meta if c not in by_iso]:
        d1_query(f"DELETE FROM product_index_meta WHERE reporter_iso3 = {lit(iso)};")
    return changed