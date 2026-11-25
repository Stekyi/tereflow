"""HS6 product code -> industry concordance (FIGARO industries, which are NACE Rev.2 divisions or groups of divisions).

Route, all tables published by the UN Statistics Division (UNSD):

  HS2022 code --(HS2022-HS2017 correlation)--> HS2017 code(s)
  HS2017 code --(CPC 2.1 - HS 2017)----------> CPC 2.1 subclass(es)
  CPC 2.1     --(CPC 2.1 - ISIC Rev.4)-------> ISIC Rev.4 class(es)
  ISIC Rev.4 division (first 2 digits) ------> FIGARO industry (64 codes)

The brief named a two-hop route CPC 2.1 -> CPC 2 -> ISIC Rev.4. UNSD also publishes a direct CPC 2.1 -> ISIC Rev.4 table,
which is used as the primary route (one table fewer, so less artificial spreading). The two-hop tables are loaded too and
used only (a) when a CPC 2.1 code is missing from the direct table and (b) as a cross-check reported in the run summary.

Rules:
* Many-to-many throughout. The UN tables carry partial flags (1 = the code on that side is only partly covered by the
  pair) but NO weights. Nothing here invents a split: an HS6 code that reaches several industries lists them all, unweighted.
* Category: 'direct' = exactly one FIGARO industry reached; 'derived_multiple' = several reached; 'unresolved' = none.
* An HS6 code that is in no nomenclature table is 'unresolved'. It is never matched to a neighbour or a parent heading.
* HS edition: Tereflow stores Comtrade 'as reported' codes. Availability metadata shows HS2022 (H6) for most reporters in
  2022-2025 and HS2017 (H5) for a few, and the edition is not stored per fact row. A code that exists in HS2022 is resolved
  through the HS2022 -> HS2017 correlation (all correlated HS2017 codes, not the single Comtrade conversion target); a code
  that exists only in HS2017 is resolved directly. Both facts are recorded in the payload.
* NACE Rev.2 and ISIC Rev.4 are assumed identical at division level. Checked in this module against the UNSD NACE2-ISIC4
  correspondence (every NACE class pairs with an ISIC class in the same division) and the Eurostat FIGARO metadata states
  industries follow NACE Rev.2 at two-digit level. The check result is stored in app_pi_sources.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
from collections import defaultdict
from pathlib import Path

CACHE = Path(__file__).resolve().parents[2] / "logs" / "pi-cache"
MAP_VERSION = "cc-1"

UN = "https://unstats.un.org/unsd/classifications/Econ/tables/"
UN_LICENCE = ("Published openly by the UN Statistics Division. Specific reuse terms for these tables were not verified in this "
              "run; see https://www.un.org/en/about-us/terms-of-use.")
ESTAT_LICENCE = ("Eurostat copyright notice (https://ec.europa.eu/eurostat/help/copyright-notice): reuse of statistical data for "
                 "commercial or non-commercial purposes is authorised provided the source is acknowledged; modifications must be stated clearly.")

SOURCES = {
    "UN_HS17_CPC21": {"name": "UNSD correspondence HS 2017 - CPC Ver. 2.1", "url": UN + "CPC/CPCv21_HS2017/CPC21-HS2017.csv",
                      "file": "hs17_cpc21.csv", "version": "HS 2017 / CPC 2.1", "direction": "HS2017 -> CPC2.1", "licence": UN_LICENCE},
    "UN_CPC21_ISIC4": {"name": "UNSD correspondence CPC Ver. 2.1 - ISIC Rev.4", "url": UN + "CPC/CPCv21_ISIC4/cpc21-isic4.txt",
                       "file": "cpc21_isic4.txt", "version": "CPC 2.1 / ISIC 4 (published 2015-08-19)", "direction": "CPC2.1 -> ISIC4", "licence": UN_LICENCE},
    "UN_CPC21_CPC2": {"name": "UNSD correspondence CPC Ver. 2.1 - CPC Ver. 2", "url": UN + "CPC/CPCv21_CPCv2/CPC21-CPC2.txt",
                      "file": "cpc21_cpc2.txt", "version": "CPC 2.1 / CPC 2 (published 2015-08-19)", "direction": "CPC2.1 -> CPC2", "licence": UN_LICENCE},
    "UN_CPC2_ISIC4": {"name": "UNSD correspondence CPC Ver. 2 - ISIC Rev.4", "url": UN + "CPC/CPCv2_ISIC4/CPC2-ISIC4.txt",
                      "file": "cpc2_isic4.txt", "version": "CPC 2 / ISIC 4 (published 2008-12-31)", "direction": "CPC2 -> ISIC4", "licence": UN_LICENCE},
    "UN_HS22_HS17": {"name": "UNSD HS2022 to HS2017 correlation (sheet 'HS2022-HS2017 Correlations')",
                     "url": UN + "HS2022toHS2017ConversionAndCorrelationTables.xlsx", "file": "hs22_hs17.xlsx",
                     "version": "HS 2022 / HS 2017", "direction": "HS2022 -> HS2017", "licence": UN_LICENCE},
    "UN_NACE2_ISIC4": {"name": "UNSD correspondence NACE Rev.2 - ISIC Rev.4", "url": UN + "ISIC/NACE2_ISIC4/NACE2_ISIC4.txt",
                       "file": "nace2_isic4.txt", "version": "NACE 2 / ISIC 4", "direction": "NACE2 -> ISIC4 (used only to check division equality)",
                       "licence": UN_LICENCE},
    "ESTAT_IND_USE": {"name": "Eurostat SDMX codelist IND_USE (FIGARO industry labels)",
                      "url": "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/codelist/ESTAT/IND_USE/latest?format=TSV&lang=en",
                      "file": "estat_ind_use.tsv", "version": "latest", "direction": "code -> label", "licence": ESTAT_LICENCE},
}

FIGARO_INDUSTRIES = ("A01 A02 A03 B C10-12 C13-15 C16 C17 C18 C19 C20 C21 C22 C23 C24 C25 C26 C27 C28 C29 C30 C31_32 C33 D35 E36 "
                     "E37-39 F G45 G46 G47 H49 H50 H51 H52 H53 I J58 J59_60 J61 J62_63 K64 K65 K66 L M69_70 M71 M72 M73 M74_75 N77 "
                     "N78 N79 N80-82 O84 P85 Q86 Q87_88 R90-92 R93 S94 S95 S96 T U").split()
# Single-letter FIGARO codes stand for a whole NACE section.
SECTION_DIVISIONS = {"B": range(5, 10), "F": range(41, 44), "I": range(55, 57), "L": range(68, 69), "T": range(97, 99), "U": range(99, 100)}

CAVEATS = [
    "Correspondence tables give possible pairings, not shares. No weights exist in the UN tables, so none are applied.",
    "An HS product can be produced by several industries and an industry makes many products; the link is many-to-many.",
    "Industry level is FIGARO (NACE Rev.2 two-digit, some divisions grouped). NACE Rev.2 equals ISIC Rev.4 at division level (checked against the UNSD NACE2-ISIC4 table).",
]

DDL = [
    """CREATE TABLE app_pi_sources (k VARCHAR2(40) PRIMARY KEY, name VARCHAR2(300), url VARCHAR2(600), version VARCHAR2(200),
       direction VARCHAR2(200), retrieved_at VARCHAR2(30), row_count NUMBER, sha256 VARCHAR2(64), licence_note VARCHAR2(1000), note CLOB)""",
    """CREATE TABLE app_pi_hs_hs (hs22 VARCHAR2(6) NOT NULL, hs17 VARCHAR2(6) NOT NULL, relationship VARCHAR2(4), PRIMARY KEY (hs22, hs17))""",
    """CREATE TABLE app_pi_hs_cpc (hs17 VARCHAR2(6) NOT NULL, hs_partial NUMBER(1), cpc21 VARCHAR2(5) NOT NULL, cpc_partial NUMBER(1),
       PRIMARY KEY (hs17, cpc21))""",
    """CREATE TABLE app_pi_cpc_cpc2 (cpc21 VARCHAR2(5) NOT NULL, cpc21_partial NUMBER(1), cpc2 VARCHAR2(5) NOT NULL, cpc2_partial NUMBER(1),
       PRIMARY KEY (cpc21, cpc2))""",
    """CREATE TABLE app_pi_cpc_isic (cpc_version VARCHAR2(4) NOT NULL, cpc VARCHAR2(5) NOT NULL, cpc_partial NUMBER(1), isic4 VARCHAR2(4) NOT NULL,
       isic_partial NUMBER(1), PRIMARY KEY (cpc_version, cpc, isic4))""",
    """CREATE TABLE app_pi_industry (code VARCHAR2(10) PRIMARY KEY, name VARCHAR2(300), section VARCHAR2(1), divisions VARCHAR2(60))""",
    """CREATE TABLE app_pi_map (hs6 VARCHAR2(6) PRIMARY KEY, version VARCHAR2(12), category VARCHAR2(20), n_industries NUMBER,
       industries VARCHAR2(400), computed_at VARCHAR2(30), payload CLOB)""",
]
TABLES = ["pi_sources", "pi_hs_hs", "pi_hs_cpc", "pi_cpc_cpc2", "pi_cpc_isic", "pi_industry", "pi_map"]


def create_tables(conn, log=print) -> None:
    cur = conn.cursor()
    for s in DDL:
        try:
            cur.execute(s)
            log("created: " + s.split("(")[0].strip())
        except Exception as e:
            if "ORA-00955" in str(e):
                continue
            raise
    conn.commit()


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


# ---------------------------------------------------------------- downloads

def fetch(url: str, path: Path, log=print, tries: int = 4, delay: float = 2.0, timeout: int = 300) -> dict:
    """Download url to path unless already cached. Returns {path, retrieved_at, sha256, cached}."""
    import requests
    path.parent.mkdir(parents=True, exist_ok=True)
    cached = path.exists() and path.stat().st_size > 0
    if not cached:
        last = None
        for i in range(tries):
            try:
                r = requests.get(url, timeout=timeout, headers={"User-Agent": "tereflow-intel/1.0", "Accept-Encoding": "gzip"})
                if r.status_code == 200 and r.content:
                    body = r.content
                    if body[:2] == b"\x1f\x8b":  # Eurostat sends gzip files without a Content-Encoding header
                        import gzip
                        body = gzip.decompress(body)
                    tmp = path.with_suffix(path.suffix + ".part")
                    tmp.write_bytes(body)
                    tmp.replace(path)
                    break
                last = f"HTTP {r.status_code}"
            except Exception as e:  # network errors are retried
                last = str(e)
            log(f"  retry {i + 1} {url}: {last}")
            time.sleep(delay * (i + 1))
        else:
            raise RuntimeError(f"download failed {url}: {last}")
    data = path.read_bytes()
    return {"path": path, "cached": cached, "sha256": hashlib.sha256(data).hexdigest(),
            "retrieved_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(path.stat().st_mtime))}


# ---------------------------------------------------------------- pure parsers

def _flag(v):
    v = (v or "").strip().strip('"')
    return int(v) if v in ("0", "1") else None


def parse_hs_cpc(text: str) -> list:
    """CPC21-HS2017.csv -> [(hs17 6 digits, hs_partial, cpc21, cpc_partial)]."""
    out = []
    rd = csv.reader(io.StringIO(text))
    next(rd)
    for r in rd:
        if len(r) < 4 or not r[0].strip():
            continue
        hs = re.sub(r"\D", "", r[0])
        if len(hs) != 6:
            continue
        out.append((hs, _flag(r[1]), r[2].strip().strip('"'), _flag(r[3])))
    return out


def parse_pairs(text: str) -> list:
    """Generic UNSD quoted CSV with code,partial,code[,partial] -> list of tuples (a, pa, b, pb or None)."""
    out = []
    rd = csv.reader(io.StringIO(text))
    next(rd)
    for r in rd:
        if len(r) < 3 or not r[0].strip():
            continue
        out.append((r[0].strip(), _flag(r[1]), r[2].strip(), _flag(r[3]) if len(r) > 3 else None))
    return out


def parse_hs22_hs17(rows) -> list:
    """Rows of the 'HS2022-HS2017 Correlations' sheet -> [(hs22, hs17, relationship)]. Header rows are skipped."""
    out = []
    for r in rows:
        if not r or r[0] is None:
            continue
        a, b = str(r[0]).strip(), str(r[1] or "").strip()
        if not (a.isdigit() and len(a) == 6 and b.isdigit() and len(b) == 6):
            continue
        out.append((a, b, (str(r[2]).strip() if len(r) > 2 and r[2] is not None else None)))
    return out


def industry_divisions(code: str) -> list:
    """FIGARO industry code -> list of NACE/ISIC division numbers. 'C10-12' range, 'C31_32' list, single letter = section."""
    if code in SECTION_DIVISIONS:
        return list(SECTION_DIVISIONS[code])
    m = re.fullmatch(r"([A-U])(\d{2})(?:([-_])(\d{2}))?", code)
    if not m:
        raise ValueError(f"not an industry code: {code}")
    a = int(m[2])
    if not m[3]:
        return [a]
    b = int(m[4])
    return list(range(a, b + 1)) if m[3] == "-" else [a, b]


def division_table(codes=FIGARO_INDUSTRIES) -> dict:
    """{division int: FIGARO code}. Raises if a division would map to two industries."""
    out = {}
    for c in codes:
        for d in industry_divisions(c):
            if d in out:
                raise ValueError(f"division {d:02d} in both {out[d]} and {c}")
            out[d] = c
    return out


def check_nace_isic_divisions(pairs: list) -> dict:
    """pairs from NACE2_ISIC4.txt. Every numeric NACE code must pair with an ISIC code in the same division."""
    n, bad = 0, []
    for nace, _, isic, _ in pairs:
        nd = nace.replace(".", "")
        if not nd[:2].isdigit():
            continue
        n += 1
        if nd[:2] != isic[:2]:
            bad.append((nace, isic))
    return {"pairs_checked": n, "cross_division_pairs": bad, "ok": n > 0 and not bad}


def parse_codelist(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        if "\t" in line:
            k, v = line.split("\t", 1)
            out[k.strip()] = v.strip()
    return out


# ---------------------------------------------------------------- pure mapping

class Tables:
    """In-memory lookups for map_hs6."""

    def __init__(self, hs22_hs17: list, hs17_cpc: list, cpc21_isic: list, cpc21_cpc2: list = (), cpc2_isic: list = (), divisions: dict = None):
        self.hs22 = defaultdict(list)
        for a, b, rel in hs22_hs17:
            self.hs22[a].append((b, rel))
        self.hs17 = defaultdict(list)
        for hs, hp, cpc, cp in hs17_cpc:
            self.hs17[hs].append((cpc, hp, cp))
        self.cpc_isic = defaultdict(list)
        for cpc, cp, isic, ip in cpc21_isic:
            self.cpc_isic[cpc].append((isic, cp, ip))
        self.cpc_cpc2 = defaultdict(list)
        for a, ap, b, bp in cpc21_cpc2:
            self.cpc_cpc2[a].append((b, ap, bp))
        self.cpc2_isic = defaultdict(list)
        for a, ap, b, _ in cpc2_isic:
            self.cpc2_isic[a].append((b, ap))
        self.div = divisions if divisions is not None else division_table()


def _isic_routes(t: Tables, cpc: str, two_hop: bool = False) -> list:
    """[(isic4, route, flags)] for one CPC 2.1 code. Direct table first; CPC 2 route only if direct has nothing or two_hop=True."""
    if not two_hop and t.cpc_isic.get(cpc):
        return [(isic, "CPC2.1->ISIC4", {"cpc_partial": cp, "isic_partial": ip}) for isic, cp, ip in t.cpc_isic[cpc]]
    out = []
    for cpc2, ap, bp in t.cpc_cpc2.get(cpc, []):
        for isic, p2 in t.cpc2_isic.get(cpc2, []):
            out.append((isic, "CPC2.1->CPC2->ISIC4", {"cpc_partial": ap, "cpc2": cpc2, "cpc2_partial": bp, "cpc2_isic_partial": p2}))
    return out


def map_hs6(hs6: str, t: Tables, two_hop: bool = False) -> dict:
    """Resolve one HS6 code. Returns the payload stored in app_pi_map (see module docstring)."""
    hs6 = (hs6 or "").strip()
    caveats = list(CAVEATS)
    basis, rel = None, []
    if hs6 in t.hs22:
        basis = "HS2022"
        hs17s = [b for b, _ in t.hs22[hs6]]
        rel = sorted({r for _, r in t.hs22[hs6] if r})
        if rel and rel != ["1:1"]:
            caveats.append(f"HS2022 {hs6} does not correspond one to one with HS2017 ({', '.join(rel)}); all correlated HS2017 codes are followed.")
        if hs6 in t.hs17 and hs6 not in hs17s:
            caveats.append("The same 6-digit code also exists in HS2017 with a different scope; data reported in HS2017 may differ.")
    elif hs6 in t.hs17:
        basis = "HS2017 only"
        hs17s = [hs6]
        caveats.append("Code exists in HS2017 but not in HS2022 (deleted or split in 2022); resolved as an HS2017 code.")
    else:
        hs17s = []
    paths = []
    for h in sorted(set(hs17s)):
        for cpc, hp, cp in t.hs17.get(h, []):
            for isic, route, fl in _isic_routes(t, cpc, two_hop):
                d = int(isic[:2]) if isic[:2].isdigit() else None
                fig = t.div.get(d) if d is not None else None
                p = {"hs17": h, "hs_partial": hp, "cpc21": cpc, "hs_cpc_partial": cp, "isic4": isic, "route": route, "figaro": fig}
                p.update(fl)
                paths.append(p)
    by = defaultdict(lambda: {"isic4": set(), "cpc21": set(), "hs17": set(), "paths": []})
    unplaced = []
    for p in paths:
        if p["figaro"] is None:
            unplaced.append(p)
            continue
        b = by[p["figaro"]]
        b["isic4"].add(p["isic4"])
        b["cpc21"].add(p["cpc21"])
        b["hs17"].add(p["hs17"])
        b["paths"].append(p)
    inds = [{"figaro": k, "isic4": sorted(v["isic4"]), "cpc21": sorted(v["cpc21"]), "hs17": sorted(v["hs17"]),
             "any_partial": any((q.get("hs_partial") == 1 or q.get("hs_cpc_partial") == 1 or q.get("cpc_partial") == 1 or q.get("isic_partial") == 1)
                                for q in v["paths"]),
             "paths": v["paths"]} for k, v in sorted(by.items())]
    n = len(inds)
    if n == 0:
        category = "unresolved"
        if basis is None:
            reason = "not an HS2017 or HS2022 6-digit code"
        elif not paths:
            reason = "no CPC/ISIC pairing in the UN tables (for 999999: commodities not specified, a confidential/residual code)"
        elif all(p["isic4"] == "n/a" for p in unplaced):
            reason = "UN CPC-ISIC table gives ISIC 'n/a' (waste, scrap or by-product with no producing industry)"
        else:
            reason = "ISIC division reached has no FIGARO industry"
    else:
        category = "direct" if n == 1 else "derived_multiple"
        reason = None
    if n > 1:
        caveats.append(f"{n} industries reached; listed unweighted because the UN tables carry no weights.")
    if unplaced:
        caveats.append(f"{len(unplaced)} path(s) ended in ISIC 'n/a' (waste or by-product) or in a division with no FIGARO industry; not counted as industries.")
    return {"hs6": hs6, "version": MAP_VERSION, "category": category, "unresolved_reason": reason, "hs_basis": basis,
            "hs2022_hs2017_relationship": rel, "hs17": sorted(set(hs17s)), "industries": inds, "weights": None,
            "unplaced_paths": unplaced, "caveats": caveats}


# ---------------------------------------------------------------- DB loading

def _read(key: str, log=print) -> tuple:
    s = SOURCES[key]
    info = fetch(s["url"], CACHE / s["file"], log)
    return info, info["path"].read_bytes()


def _text(b: bytes) -> str:
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("latin-1", "replace")


def load_tables(log=print) -> tuple:
    """Download (or read cached) sources and parse them. Returns (parsed dict, source records)."""
    import openpyxl
    recs, parsed = {}, {}
    for key in SOURCES:
        info, raw = _read(key, log)
        if key == "UN_HS22_HS17":
            wb = openpyxl.load_workbook(info["path"], read_only=True)
            parsed[key] = parse_hs22_hs17(wb["HS2022-HS2017 Correlations"].iter_rows(values_only=True))
            wb.close()
        elif key == "UN_HS17_CPC21":
            parsed[key] = parse_hs_cpc(_text(raw))
        elif key == "ESTAT_IND_USE":
            parsed[key] = parse_codelist(_text(raw))
        else:
            parsed[key] = parse_pairs(_text(raw))
        s = SOURCES[key]
        recs[key] = {"name": s["name"], "url": s["url"], "version": s["version"], "direction": s["direction"],
                     "retrieved_at": info["retrieved_at"], "rows": len(parsed[key]), "sha256": info["sha256"], "licence": s["licence"], "note": None}
        log(f"  {key}: {len(parsed[key])} rows ({'cached' if info['cached'] else 'downloaded'})")
    chk = check_nace_isic_divisions(parsed["UN_NACE2_ISIC4"])
    recs["UN_NACE2_ISIC4"]["note"] = json.dumps({"division_equality_check": chk})
    if not chk["ok"]:
        log(f"  WARNING NACE/ISIC division check failed: {chk['cross_division_pairs'][:5]}")
    return parsed, recs


def write_sources(conn, recs: dict) -> None:
    cur = conn.cursor()
    cur.executemany("DELETE FROM app_pi_sources WHERE k = :1", [(k,) for k in recs])
    cur.setinputsizes(None, None, None, None, None, None, None, None, None, __import__("oracledb").DB_TYPE_CLOB)
    cur.executemany("""INSERT INTO app_pi_sources (k, name, url, version, direction, retrieved_at, row_count, sha256, licence_note, note)
                       VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10)""",
                    [(k, r["name"], r["url"], r["version"], r["direction"], r["retrieved_at"], r["rows"], r["sha256"], r["licence"], r.get("note"))
                     for k, r in recs.items()])
    conn.commit()


def _replace(cur, table: str, cols: str, rows: list) -> None:
    cur.execute(f"DELETE FROM {table}")
    ph = ", ".join(f":{i + 1}" for i in range(len(cols.split(","))))
    for i in range(0, len(rows), 20000):
        cur.executemany(f"INSERT INTO {table} ({cols}) VALUES ({ph})", rows[i:i + 20000])


def load_sources(conn, log=print) -> dict:
    """Store the raw correspondence tables, the industry table and source records. Returns the parsed tables."""
    parsed, recs = load_tables(log)
    cur = conn.cursor()
    _replace(cur, "app_pi_hs_hs", "hs22, hs17, relationship", sorted(set(parsed["UN_HS22_HS17"])))
    # The UN files can repeat a pair; keep the first occurrence so the primary key holds.
    def dedup(rows, key):
        seen, out = set(), []
        for r in rows:
            k = key(r)
            if k not in seen:
                seen.add(k)
                out.append(r)
        return out
    _replace(cur, "app_pi_hs_cpc", "hs17, hs_partial, cpc21, cpc_partial", dedup(parsed["UN_HS17_CPC21"], lambda r: (r[0], r[2])))
    _replace(cur, "app_pi_cpc_cpc2", "cpc21, cpc21_partial, cpc2, cpc2_partial", dedup(parsed["UN_CPC21_CPC2"], lambda r: (r[0], r[2])))
    rows = [("2.1",) + r for r in parsed["UN_CPC21_ISIC4"]] + [("2",) + r for r in parsed["UN_CPC2_ISIC4"]]
    _replace(cur, "app_pi_cpc_isic", "cpc_version, cpc, cpc_partial, isic4, isic_partial", dedup(rows, lambda r: (r[0], r[1], r[3])))
    names = parsed["ESTAT_IND_USE"]
    ind_rows = [(c, names.get(c), c[0], ",".join(f"{d:02d}" for d in industry_divisions(c))) for c in FIGARO_INDUSTRIES]
    _replace(cur, "app_pi_industry", "code, name, section, divisions", ind_rows)
    conn.commit()
    write_sources(conn, recs)
    log(f"stored correspondence tables and {len(ind_rows)} industries")
    return {"parsed": parsed, "sources": recs}


def data_codes(conn, year: int = 2025, flow: str = "M") -> dict:
    """{hs6: value_usd} for HS6-level facts (partner rows, World excluded), one year and flow."""
    cur = conn.cursor()
    cur.execute("""SELECT SUBSTR(cmd_code, 1, 6), SUM(value_usd) FROM tf_trade_facts
                    WHERE year = :1 AND flow = :2 AND classification_level = 'HS6' AND partner_iso3 <> 'WLD'
                    GROUP BY SUBSTR(cmd_code, 1, 6)""", [year, flow])
    return {c: (None if v is None else float(v)) for c, v in cur if c}


def match_rates(codes: dict, t: Tables) -> dict:
    tot_v = sum(v for v in codes.values() if v)
    def rate(pred):
        ks = [c for c in codes if pred(c)]
        v = sum(codes[c] or 0.0 for c in ks)
        return {"codes": len(ks), "share_codes_pct": round(100.0 * len(ks) / len(codes), 2) if codes else None,
                "value_usd": round(v), "share_value_pct": round(100.0 * v / tot_v, 3) if tot_v else None}
    return {"codes_total": len(codes), "value_total_usd": round(tot_v),
            "in_hs2017_table": rate(lambda c: c in t.hs17),
            "in_hs2022_correlation": rate(lambda c: c in t.hs22),
            "in_either": rate(lambda c: c in t.hs17 or c in t.hs22),
            "in_neither": rate(lambda c: c not in t.hs17 and c not in t.hs22)}


def build_map(conn, write: bool = True, log=print, year: int = 2025) -> dict:
    t0 = time.time()
    loaded = load_sources(conn, log) if write else {"parsed": load_tables(log)[0]}
    p = loaded["parsed"]
    t = Tables(p["UN_HS22_HS17"], p["UN_HS17_CPC21"], p["UN_CPC21_ISIC4"], p["UN_CPC21_CPC2"], p["UN_CPC2_ISIC4"])
    codes = data_codes(conn, year)
    universe = sorted(set(t.hs22) | set(t.hs17) | set(codes))
    results = {c: map_hs6(c, t) for c in universe}
    cats = defaultdict(int)
    for r in results.values():
        cats[r["category"]] += 1
    data_cats = defaultdict(lambda: [0, 0.0])
    for c, v in codes.items():
        a = data_cats[results[c]["category"]]
        a[0] += 1
        a[1] += v or 0.0
    # Cross-check: direct CPC2.1->ISIC4 table against the two-hop route via CPC 2.
    same = diff = 0
    diffs = []
    for c in universe:
        if results[c]["category"] == "unresolved":
            continue
        a = {i["figaro"] for i in results[c]["industries"]}
        b = {i["figaro"] for i in map_hs6(c, t, two_hop=True)["industries"]}
        if a == b:
            same += 1
        else:
            diff += 1
            if len(diffs) < 10:
                diffs.append({"hs6": c, "direct": sorted(a), "via_cpc2": sorted(b)})
    summary = {"codes_mapped": len(results), "categories_all_codes": dict(cats),
               "data_year": year, "data_match": match_rates(codes, t),
               "data_categories": {k: {"codes": v[0], "value_usd": round(v[1])} for k, v in data_cats.items()},
               "data_unresolved_reasons": {k: {"codes": sum(1 for c in codes if results[c]["unresolved_reason"] == k),
                                               "value_usd": round(sum(codes[c] or 0.0 for c in codes if results[c]["unresolved_reason"] == k))}
                                           for k in sorted({r["unresolved_reason"] for r in results.values() if r["unresolved_reason"]})},
               "route_cross_check": {"same_industries": same, "different": diff, "examples": diffs},
               "nace_isic_check": json.loads(loaded.get("sources", {}).get("UN_NACE2_ISIC4", {}).get("note") or "null") if write else None,
               "seconds": None}
    if write:
        cur = conn.cursor()
        now = _now()
        rows = [(c, MAP_VERSION, r["category"], len(r["industries"]), ",".join(i["figaro"] for i in r["industries"])[:400], now,
                 json.dumps(r, separators=(",", ":"))) for c, r in results.items()]
        cur.execute("DELETE FROM app_pi_map")
        cur.setinputsizes(None, None, None, None, None, None, __import__("oracledb").DB_TYPE_CLOB)
        for i in range(0, len(rows), 2000):
            cur.executemany("INSERT INTO app_pi_map (hs6, version, category, n_industries, industries, computed_at, payload) VALUES (:1, :2, :3, :4, :5, :6, :7)",
                            rows[i:i + 2000])
        cur.execute("DELETE FROM app_pi_sources WHERE k = 'MAP_RUN'")
        cur = conn.cursor()
        cur.setinputsizes(None, None, None, __import__("oracledb").DB_TYPE_CLOB)
        cur.execute("""INSERT INTO app_pi_sources (k, name, url, version, direction, retrieved_at, row_count, sha256, licence_note, note)
                       VALUES ('MAP_RUN', 'HS6 to FIGARO industry map build', NULL, :1, 'HS6 -> FIGARO', :2, :3, NULL, NULL, :4)""",
                    [MAP_VERSION, now, len(rows), json.dumps(summary)])
        conn.commit()
    summary["seconds"] = round(time.time() - t0, 1)
    summary["results"] = results
    return summary
