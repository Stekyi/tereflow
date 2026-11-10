"""Create the application tables in Oracle from the SQLite (D1) schema.

Run:  python -m tereflow_oracle create-app-schema [--prefix app_] [--drop]
      python -m tereflow_oracle export-app-tables        (writes shared/app-tables.ts)

The source is the CREATE statements held in logs/d1master.json (a dump of sqlite_master from D1). The conversion is explicit
and small: types, defaults, primary keys, unique constraints, foreign keys, indexes. Things Oracle cannot express the same way
are handled once, here:

  * an empty string is NULL in Oracle, so the app stores empty strings as a one-character sentinel (see shared/sql-oracle.ts);
    a column that defaults to '' defaults to that sentinel
  * partial unique indexes (WHERE col IS NOT NULL) become function-based indexes
  * columns named trigger, raw, mode and share (Oracle reserved words) get a trailing underscore
  * long text columns become CLOB
"""
from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SENTINEL_DEFAULT = "CHR(1)"
RENAMED = {"trigger": "trigger_", "raw": "raw_", "mode": "mode_", "share": "share_", "comment": "comment_"}

# Tables that belong to the old D1 trade and analysis pipeline. They stay where they are (read only) until the code that reads
# them is retired; everything else is application data and moves to Oracle.
LEGACY = {
    "trade_facts", "trade_observations", "opportunity_signals", "opportunity_metrics", "product_analytics", "raw_trade_data",
    "analysis_results", "analysis_runs", "ingestion_runs", "comtrade_ingestion_state",
    "source_attempts", "product_index", "product_index_meta", "data_uploads", "upload_issues", "opportunities",
    "business_cards_fts", "business_cards_fts_data", "business_cards_fts_idx", "business_cards_fts_content",
    "business_cards_fts_docsize", "business_cards_fts_config", "d1_migrations",
}
CLOB_NAME = re.compile(r"^(body|body_md|description|notes|payload|content|message|error_message|log|api_notes|research_links|summary|summary_md|evidence|explanation|bio|about|detail|details|text|raw|raw_json|answer|question|comment|reply|why|[a-z_]*_json|[a-z_]*_md)$")


def split_top(s: str) -> list[str]:
    parts, depth, cur, q = [], 0, "", False
    for ch in s:
        if ch == "'":
            q = not q
        if not q:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append(cur.strip())
                cur = ""
                continue
        cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return parts


def strip_comments(sql: str) -> str:
    return "\n".join(re.sub(r"--.*$", "", line) for line in sql.splitlines())


def oracle_type(name: str, sqlite_type: str, indexed: bool = False) -> str:
    t = (sqlite_type or "").upper()
    if t.startswith("INT"):
        return "NUMBER(19)"
    if t in ("REAL", "FLOAT", "DOUBLE", "NUMERIC"):
        return "NUMBER"
    if t == "BLOB":
        return "BLOB"
    if CLOB_NAME.search(name) and not indexed:
        return "CLOB"
    # Indexed text columns are kept short: an index key has a size limit, and a composite key adds the columns together.
    return "VARCHAR2(300)" if indexed else "VARCHAR2(4000)"


def oracle_default(expr: str) -> str | None:
    e = expr.strip()
    if e.startswith("(") and e.endswith(")"):
        e = e[1:-1].strip()
    if re.fullmatch(r"datetime\(\s*'now'\s*\)", e, re.I):
        return "TO_CHAR(SYSTIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
    if e == "''":
        return SENTINEL_DEFAULT
    if re.fullmatch(r"-?\d+(\.\d+)?", e):
        return e
    if re.fullmatch(r"'[^']*'", e):
        return e
    if e.upper() == "NULL":
        return None
    raise ValueError(f"unsupported default: {expr}")


def read_default(rest: str) -> str:
    """The expression after DEFAULT: a balanced parenthesised expression, a quoted string, or a bare token."""
    m = re.search(r"\bDEFAULT\s+", rest, re.I)
    s = rest[m.end():]
    if s.startswith("("):
        depth, q = 0, False
        for i, ch in enumerate(s):
            if ch == "'":
                q = not q
            if not q:
                depth += ch == "("
                depth -= ch == ")"
                if depth == 0:
                    return s[:i + 1]
    if s.startswith("'"):
        j = 1
        while j < len(s):
            if s[j] == "'" and s[j + 1:j + 2] == "'":
                j += 2
            elif s[j] == "'":
                return s[:j + 1]
            else:
                j += 1
    return re.match(r"[-\w.]+", s).group(0)


def col_name(c: str) -> str:
    return RENAMED.get(c.lower(), c)


def parse_table(sql: str) -> dict:
    sql = strip_comments(sql)
    m = re.match(r"\s*CREATE TABLE\s+(?:IF NOT EXISTS\s+)?\"?(\w+)\"?\s*\((.*)\)\s*(?:WITHOUT ROWID)?\s*$", sql, re.S | re.I)
    if not m:
        raise ValueError(f"cannot parse: {sql[:80]}")
    table, body = m.group(1), m.group(2)
    cols, pk, uniques, fks, checks = [], [], [], [], []
    for d in split_top(body):
        up = d.upper()
        if up.startswith("PRIMARY KEY"):
            pk = [x.strip() for x in re.search(r"\((.*)\)", d, re.S).group(1).split(",")]
        elif up.startswith("UNIQUE"):
            uniques.append([x.strip() for x in re.search(r"\((.*)\)", d, re.S).group(1).split(",")])
        elif up.startswith("FOREIGN KEY"):
            mm = re.match(r"FOREIGN KEY\s*\((\w+)\)\s*REFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON DELETE\s+(CASCADE|SET NULL))?", d, re.I)
            if mm:
                fks.append((mm.group(1), mm.group(2), mm.group(3), (mm.group(4) or "").upper()))
        elif up.startswith("CHECK") or up.startswith("CONSTRAINT"):
            checks.append(d)
        else:
            tokens = re.match(r"\"?(\w+)\"?\s*(\w*)\s*(.*)$", d, re.S)
            name, typ, rest = tokens.group(1), tokens.group(2), tokens.group(3)
            if typ.upper() in ("NOT", "PRIMARY", "UNIQUE", "DEFAULT", "REFERENCES", "CHECK", "NULL"):
                rest, typ = (typ + " " + rest).strip(), ""
            notnull = bool(re.search(r"\bNOT NULL\b", rest, re.I))
            default = oracle_default(read_default(rest)) if re.search(r"\bDEFAULT\b", rest, re.I) else None
            if re.search(r"\bPRIMARY KEY\b", rest, re.I):
                pk = [name]
            if re.search(r"\bUNIQUE\b", rest, re.I):
                uniques.append([name])
            rm = re.search(r"\bREFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON DELETE\s+(CASCADE|SET NULL))?", rest, re.I)
            if rm:
                fks.append((name, rm.group(1), rm.group(2), (rm.group(3) or "").upper()))
            cm = re.search(r"\bCHECK\s*\((.*)\)\s*$", rest, re.S | re.I) or re.search(r"\bCHECK\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)", rest, re.I)
            if cm:
                checks.append(f"CHECK ({cm.group(1)})")
            cols.append({"name": name, "type": oracle_type(name, typ), "notnull": notnull, "default": default, "sqlite_type": typ, "auto": bool(re.search(r"\bAUTOINCREMENT\b", rest, re.I))})
    return {"table": table, "cols": cols, "pk": pk, "uniques": uniques, "fks": fks, "checks": checks}


def table_ddl(t: dict, prefix: str, indexed: set[str] | None = None) -> str:
    lines = []
    for c in t["cols"]:
        ctype = oracle_type(c["name"], c["sqlite_type"], c["name"] in (indexed or set())) if c["type"] in ("CLOB", "VARCHAR2(4000)") else c["type"]
        parts = [col_name(c["name"]), "NUMBER GENERATED BY DEFAULT ON NULL AS IDENTITY" if c.get("auto") else ctype]
        if c["default"] is not None:
            parts.append(f"DEFAULT {c['default']}")
        if c["notnull"] or c["name"] in t["pk"]:
            parts.append("NOT NULL")
        lines.append(" ".join(parts))
    if t["pk"]:
        lines.append(f"PRIMARY KEY ({', '.join(col_name(c) for c in t['pk'])})")
    for u in t["uniques"]:
        lines.append(f"UNIQUE ({', '.join(col_name(c) for c in u)})")
    for ck in t["checks"]:
        # Checks that mention an empty string cannot hold under the sentinel scheme; the rest are plain IN lists and comparisons.
        if "''" not in ck and "datetime" not in ck.lower() and "length(" not in ck.lower():
            lines.append(re.sub(r"\bmode\b", "mode_", ck))
    return f"CREATE TABLE {prefix}{t['table']} (\n  " + ",\n  ".join(lines) + "\n)"


def index_ddl(sql: str, prefix: str, tables: set[str]) -> str | None:
    m = re.match(r"CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\((.*?)\)\s*(WHERE\s+(.*))?$", strip_comments(sql).strip(), re.S | re.I)
    if not m:
        return None
    uniq, name, table, cols, _, where = m.groups()
    if table not in tables:
        return None
    parts = [c.strip() for c in cols.split(",")]
    if where:
        wm = re.fullmatch(r"\s*(\w+)\s+IS NOT NULL\s*", where, re.I)
        if not wm:
            return None
        guard = wm.group(1)
        parts = [f"CASE WHEN {col_name(guard)} IS NOT NULL THEN {re.sub(r'\s+(ASC|DESC)$', '', col_name(p), flags=re.I)} END" for p in parts]
    else:
        parts = [re.sub(r"^(\w+)", lambda x: col_name(x.group(1)), p) for p in parts]
    return f"CREATE {'UNIQUE ' if uniq else ''}INDEX {prefix}{name} ON {prefix}{table} ({', '.join(parts)})"


def load_master() -> list[dict]:
    raw = (ROOT / "logs" / "d1master.json").read_text(encoding="utf-8-sig")
    return json.loads(raw)[0]["results"]


def generate(prefix: str = "app_") -> dict:
    master = load_master()
    tables = {}
    for o in master:
        if o["type"] == "table" and o["name"] not in LEGACY and not o["name"].startswith(("sqlite_", "_cf_")):
            tables[o["name"]] = parse_table(o["sql"])
    names = set(tables)
    indexed: dict[str, set[str]] = {n: set(t["pk"]) | {c for u in t["uniques"] for c in u} | {fk[0] for fk in t["fks"]} for n, t in tables.items()}
    for o in master:
        if o["type"] == "index" and o["tbl_name"] in indexed:
            im = re.search(r"\((.*?)\)", strip_comments(o["sql"]), re.S)
            if im:
                indexed[o["tbl_name"]] |= {re.sub(r"\s+(ASC|DESC)$", "", c.strip(), flags=re.I) for c in im.group(1).split(",")}
    for fk_t in tables.values():
        for _c, ref, refcol, _d in fk_t["fks"]:
            if ref in indexed:
                indexed[ref].add(refcol)
    ddl = [table_ddl(t, prefix, indexed[n]) for n, t in tables.items()]
    fk = []
    for t in tables.values():
        for col, ref, refcol, on_delete in t["fks"]:
            if ref in names:
                clause = f" ON DELETE {on_delete}" if on_delete else ""
                fk.append(f"ALTER TABLE {prefix}{t['table']} ADD FOREIGN KEY ({col_name(col)}) REFERENCES {prefix}{ref} ({col_name(refcol)}){clause}")
    idx = [d for o in master if o["type"] == "index" and (d := index_ddl(o["sql"], prefix, names))]
    return {"tables": sorted(names), "ddl": ddl, "fks": fk, "indexes": idx}


def create(conn, prefix: str = "app_", drop: bool = False) -> dict:
    g = generate(prefix)
    cur = conn.cursor()
    if drop:
        for t in reversed(g["tables"]):
            cur.execute(f"DROP TABLE IF EXISTS {prefix}{t} CASCADE CONSTRAINTS PURGE")
    for s in g["ddl"]:
        cur.execute(s)
    for s in g["fks"] + g["indexes"]:
        try:
            cur.execute(s)
        except Exception as e:  # a missing referenced column or duplicate index is reported, not fatal
            print("  skipped:", s[:110], "->", str(e)[:90])
    conn.commit()
    return g


# Oracle-only application tables that have no D1 definition (created by their own job, not copied from D1).
EXTRA_APP_TABLES = {'forecasts'}


def export_tables_ts() -> str:
    names = sorted(set(generate("app_")["tables"]) | EXTRA_APP_TABLES)
    body = ",\n  ".join(f"'{n}'" for n in names)
    return ("// Generated by `python -m tereflow_oracle export-app-tables`. The application tables that live in Oracle.\n"
            "// Every other table (the old trade and analysis tables) stays in D1, read only, until the code that reads it is retired.\n"
            f"export const APP_TABLES: readonly string[] = [\n  {body},\n];\n")


def copy_data(conn, prefix: str = "app_", truncate: bool = True) -> dict[str, int]:
    """Copy the application rows from D1 into the Oracle tables (reads D1 over the REST API; D1 is not written).

    Empty strings become the sentinel, column names that are Oracle words are renamed, and tables are loaded in
    foreign-key order."""
    from .d1sync import d1_query
    master = {o["name"]: parse_table(o["sql"]) for o in load_master()
              if o["type"] == "table" and o["name"] not in LEGACY and not o["name"].startswith(("sqlite_", "_cf_"))}
    order: list[str] = []
    seen: set[str] = set()

    def visit(n: str) -> None:
        if n in seen or n not in master:
            return
        seen.add(n)
        for _c, ref, _rc, _d in master[n]["fks"]:
            if ref != n:
                visit(ref)
        order.append(n)

    for n in sorted(master):
        visit(n)
    cur = conn.cursor()
    if truncate:
        for n in reversed(order):
            cur.execute(f"DELETE FROM {prefix}{n}")
        conn.commit()
    counts: dict[str, int] = {}
    for n in order:
        rows: list[dict] = []
        offset = 0
        while True:
            res = d1_query(f"SELECT * FROM {n} LIMIT 2000 OFFSET {offset}")
            got = res[0]["results"]
            rows += got
            if len(got) < 2000:
                break
            offset += 2000
        counts[n] = len(rows)
        if not rows:
            continue
        cols = list(rows[0].keys())
        sql = f"INSERT INTO {prefix}{n} ({', '.join(col_name(c) for c in cols)}) VALUES ({', '.join(f':{i + 1}' for i in range(len(cols)))})"
        data = []
        for r in rows:
            vals = []
            for c in cols:
                v = r[c]
                vals.append("\x01" if v == "" else v)
            data.append(vals)
        cur.executemany(sql, data)
        conn.commit()
    return counts
