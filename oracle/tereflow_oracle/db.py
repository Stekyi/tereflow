"""Oracle connection and the SQL migration runner."""
from __future__ import annotations
import os
import re
from pathlib import Path

import oracledb

from .config import need

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schema"


def connect(app: bool = False) -> oracledb.Connection:
    """Open a wallet connection. Same mechanism as the proven test_oracle_connect.py.

    app=True uses the least-privilege ORACLE_APP_* login when configured.
    """
    wallet = os.environ.get("ORACLE_WALLET_PATH", "./Wallet_tereflow")
    if not os.path.isabs(wallet):
        wallet = str(Path(__file__).resolve().parents[2] / wallet)
    user_k, pw_k = ("ORACLE_APP_USER", "ORACLE_APP_PASSWORD") if app and os.environ.get("ORACLE_APP_USER") else ("ORACLE_DB_USER", "ORACLE_DB_PASSWORD")
    conn = oracledb.connect(
        user=need(user_k),
        password=need(pw_k),
        dsn=os.environ.get("ORACLE_TNS_NAME", "tereflow_high"),
        config_dir=wallet,
        wallet_location=wallet,
        wallet_password=need("ORACLE_WALLET_PASSWORD"),
    )
    # The HIGH service enables parallel DML, which deadlocks siblings on small transactional loads.
    cur = conn.cursor()
    cur.execute("ALTER SESSION DISABLE PARALLEL DML")
    cur.execute("ALTER SESSION DISABLE PARALLEL QUERY")
    return conn


def split_statements(sql: str) -> list[str]:
    out = []
    for chunk in re.split(r"^--;;\s*$", sql, flags=re.M):
        body = "\n".join(l for l in chunk.splitlines() if not l.strip().startswith("--")).strip()
        if body:
            out.append(body)
    return out


def migrate(conn: oracledb.Connection) -> list[str]:
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS tf_schema_migrations (name VARCHAR2(120) PRIMARY KEY, applied_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL)")
    cur.execute("SELECT name FROM tf_schema_migrations")
    done = {r[0] for r in cur}
    applied = []
    for f in sorted(SCHEMA_DIR.glob("*.sql")):
        if f.name in done:
            continue
        for stmt in split_statements(f.read_text(encoding="utf-8")):
            cur.execute(stmt)
        cur.execute("INSERT INTO tf_schema_migrations (name) VALUES (:1)", [f.name])
        conn.commit()
        applied.append(f.name)
    return applied


