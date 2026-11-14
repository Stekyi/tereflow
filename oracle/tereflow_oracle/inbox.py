"""Load collector CSV files that an operator uploaded through the admin inbox.

The Worker only stores the files (Cloudflare R2, prefix collector-inbox/pending/). This command, which holds
the database credentials, validates each one, swaps that country-year-flow into tf_trade_facts in one
transaction, recomputes the country's analysis and moves the file to done/ (or rejected/ with the reason).
"""
from __future__ import annotations
import csv
import io
import os
import re
import uuid

from . import analytics, dashboard, opportunity
from .ingest import ISO3_M49, BATCH

NAME = re.compile(r"^([A-Z]{3})_(\d{4})_([XM])\.csv$")
FIELDS = ["partner_iso3", "hs_code", "description", "value_usd", "net_weight_kg", "qty", "qty_unit"]
PENDING, DONE, REJECTED = "collector-inbox/pending/", "collector-inbox/done/", "collector-inbox/rejected/"


def _s3():
    import boto3  # imported here so the other commands do not need it
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_API_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def _num(v):
    if v is None or str(v).strip() == "":
        return None
    return float(v)


def parse(name: str, text: str, max_year: int) -> tuple[str, int, str, list[tuple], list[str]]:
    """Validate one file. Returns (iso3, year, flow, rows, problems); any problem refuses the whole file."""
    m = NAME.match(name)
    if not m:
        return "", 0, "", [], [f"file name '{name}' must look like ETH_2024_X.csv"]
    iso3, year, flow = m.group(1), int(m.group(2)), m.group(3)
    problems: list[str] = []
    if iso3 not in ISO3_M49:
        problems.append(f"{iso3} is not a known country code")
    if year < 1995 or year > max_year:
        problems.append(f"year {year} is outside 1995 to {max_year}")
    rd = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    missing = [f for f in FIELDS if f not in (rd.fieldnames or [])]
    if missing:
        return iso3, year, flow, [], problems + [f"missing column(s): {', '.join(missing)}"]
    rows, seen = [], set()
    for n, r in enumerate(rd, start=2):
        p, code = (r["partner_iso3"] or "").strip(), (r["hs_code"] or "").strip()
        if not re.fullmatch(r"[A-Z]{3}", p):
            problems.append(f"line {n}: partner '{p}' must be three capital letters")
        elif not re.fullmatch(r"\d{6}", code):
            problems.append(f"line {n}: hs_code '{code}' must be six digits")
        elif (p, code) in seen:
            problems.append(f"line {n}: {p} {code} appears twice")
        else:
            seen.add((p, code))
            try:
                v, w, q = _num(r["value_usd"]), _num(r["net_weight_kg"]), _num(r["qty"])
            except ValueError:
                problems.append(f"line {n}: value, weight or quantity is not a number")
                continue
            if v is None or v < 0:
                problems.append(f"line {n}: value_usd must be a number of zero or more")
                continue
            rows.append((p, code, ((r["description"] or "")[:500] or None), v, w, q, ((r["qty_unit"] or "")[:20] or None)))
        if len(problems) >= 25:
            problems.append("stopped after 25 problems")
            break
    if not rows and not problems:
        problems.append("no data rows")
    return iso3, year, flow, rows, problems


def load(conn, iso3: str, year: int, flow: str, rows: list[tuple], run_id: str) -> None:
    """Swap one country-year-flow in atomically; a failure before the commit leaves the old data untouched."""
    cur = conn.cursor()
    cur.execute("DELETE FROM tf_trade_facts WHERE reporter_iso3=:1 AND year=:2 AND flow=:3", [iso3, year, flow])
    sql = """INSERT INTO tf_trade_facts (reporter_iso3, partner_iso3, year, flow, cmd_code, classification_level,
             cmd_desc, value_usd, net_weight_kg, qty, qty_unit, last_released, run_id)
             VALUES (:1,:2,:3,:4,:5,'HS6',:6,:7,:8,:9,:10,NULL,:11)"""
    data = [(iso3, p, year, flow, code, d, v, w, q, u, run_id) for p, code, d, v, w, q, u in rows]
    for i in range(0, len(data), BATCH):
        cur.executemany(sql, data[i:i + BATCH])
    cur.execute("""MERGE INTO tf_ingest_state t USING (SELECT :r r, :y y, :f f FROM dual) s
        ON (t.reporter_iso3=s.r AND t.year=s.y AND t.flow=s.f)
        WHEN MATCHED THEN UPDATE SET status='SUCCESS', classification_level='HS6', classification_source='collector-upload',
             records=:n, run_id=:rid, error_message=NULL, updated_at=SYSTIMESTAMP, finished_at=SYSTIMESTAMP
        WHEN NOT MATCHED THEN INSERT (reporter_iso3, year, flow, status, classification_level, classification_source,
             records, run_id, retry_count, started_at, finished_at)
             VALUES (:r, :y, :f, 'SUCCESS', 'HS6', 'collector-upload', :n, :rid, 0, SYSTIMESTAMP, SYSTIMESTAMP)""",
        dict(r=iso3, y=year, f=flow, n=len(rows), rid=run_id))
    conn.commit()


def run(conn, dry_run: bool = False, log=print) -> int:
    from datetime import date
    s3 = _s3()
    bucket = os.environ.get("S3_BUCKET", "tereflow-media")
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket=bucket, Prefix=PENDING).get("Contents", []) if o["Key"] != PENDING]
    if not keys:
        log("inbox: nothing waiting")
        return 0
    run_id = str(uuid.uuid4())
    loaded: set[str] = set()
    if not dry_run:
        conn.cursor().execute("INSERT INTO tf_ingest_run (run_id, kind, status, dry_run) VALUES (:1,'comtrade','RUNNING',0)", [run_id])
        conn.commit()
    ok = bad = total = 0
    for key in sorted(keys):
        name = key[len(PENDING):]
        text = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8", errors="replace")
        iso3, year, flow, rows, problems = parse(name, text, date.today().year)
        if problems:
            bad += 1
            log(f"inbox {name}: REFUSED ({'; '.join(problems[:3])})")
            if not dry_run:
                s3.put_object(Bucket=bucket, Key=REJECTED + name + ".reason.txt", Body="\n".join(problems).encode("utf-8"))
                s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=REJECTED + name)
                s3.delete_object(Bucket=bucket, Key=key)
            continue
        log(f"inbox {name}: {len(rows):,} rows{' (dry run)' if dry_run else ''}")
        if dry_run:
            continue
        load(conn, iso3, year, flow, rows, run_id)
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=DONE + name)
        s3.delete_object(Bucket=bucket, Key=key)
        loaded.add(iso3)
        ok += 1
        total += len(rows)
    if not dry_run:
        conn.cursor().execute("UPDATE tf_ingest_run SET status=:1, finished_at=SYSTIMESTAMP, detail=:2 WHERE run_id=:3",
                              ["SUCCESS" if not bad else "PARTIAL", f"collector inbox: loaded={ok} refused={bad} rows={total}", run_id])
        conn.commit()
        for c in sorted(loaded):
            log(f"metrics {c}: {analytics.refresh_metrics(conn, c):,} products")
            if c in opportunity.CONFIG:
                log(f"opportunities {c}: {opportunity.refresh_opportunities(conn, c):,} scored")
            log(f"dashboard {c}: {dashboard.refresh_dashboard(conn, c)} payloads cached")
    log(f"inbox: loaded {ok}, refused {bad}")
    return 0 if not bad else 2


def run_folder(conn, folder: str, dry_run: bool = False, log=print) -> int:
    """Same checks and the same atomic load as the admin inbox, for CSV files already on this machine."""
    from datetime import date
    from pathlib import Path
    files = sorted(p for p in Path(folder).glob("*.csv") if not p.name.endswith(".partial.csv"))
    if not files:
        log(f"{folder}: no collector CSV files found")
        return 1
    run_id = str(uuid.uuid4())
    if not dry_run:
        conn.cursor().execute("INSERT INTO tf_ingest_run (run_id, kind, status, dry_run) VALUES (:1,'comtrade','RUNNING',0)", [run_id])
        conn.commit()
    loaded: set[str] = set()
    ok = bad = total = 0
    for f in files:
        iso3, year, flow, rows, problems = parse(f.name, f.read_text(encoding="utf-8", errors="replace"), date.today().year)
        if problems:
            bad += 1
            log(f"{f.name}: REFUSED ({'; '.join(problems[:3])})")
            continue
        log(f"{f.name}: {len(rows):,} rows{' (dry run, not loaded)' if dry_run else ''}")
        if dry_run:
            continue
        load(conn, iso3, year, flow, rows, run_id)
        loaded.add(iso3)
        ok += 1
        total += len(rows)
    if not dry_run:
        conn.cursor().execute("UPDATE tf_ingest_run SET status=:1, finished_at=SYSTIMESTAMP, detail=:2 WHERE run_id=:3",
                              ["SUCCESS" if not bad else "PARTIAL", f"folder load: loaded={ok} refused={bad} rows={total}", run_id])
        conn.commit()
        for c in sorted(loaded):
            log(f"metrics {c}: {analytics.refresh_metrics(conn, c):,} products")
            if c in opportunity.CONFIG:
                log(f"opportunities {c}: {opportunity.refresh_opportunities(conn, c):,} scored")
            log(f"dashboard {c}: {dashboard.refresh_dashboard(conn, c)} payloads cached")
    log(f"loaded {ok}, refused {bad}")
    return 0 if not bad else 2