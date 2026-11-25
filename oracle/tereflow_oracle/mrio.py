"""MRIO production network engine on the Eurostat FIGARO inter-country input-output table (industry by industry).

Source: Eurostat dataset naio_10_fcp_ii4 (SDMX id ESTAT:NAIO_10_FCP_II4(1.0)), million EUR, current basic prices.
Licence (Eurostat copyright notice): reuse of statistical data for commercial or non-commercial purposes is authorised
provided the source is acknowledged; modifications to the data must be stated clearly. Tereflow derives technical and
Leontief coefficients from the published flows; that derivation is a modification and is stated in app_pi_io_meta.

Second source: the OECD ICIO site returned HTTP 403 from this machine, so OECD ICIO is NOT integrated. app_pi_io carries a
`source` column so a second source can be stored alongside without overwriting (smallest unblock: download the ICIO zip
by hand into a folder and write a loader for it). Nothing for it is built here.

Orientation (checked on the data, see orientation_check):
  row    = supplying (c_orig, ind_ava)
  column = using     (c_dest, ind_use)
  Checks on Belgium 2024: A01 (agriculture) column buys 2861.6 of C10-12 (feed), 290.5 of C20 (chemicals incl.
  fertiliser), 251.8 of C19 (refined fuel) and only 1.5 of A01 output goes to F (construction). Independent check over
  all 50 regions: B (mining, incl. crude oil) sold into C19 (refineries) is about 13,600 MEUR in the BE destination file
  alone while C19 sold into B is 16.5. A supplier-to-user reading is the only one consistent with both.
  So Z[i, j] = purchases by column j from row i, x_j = column total (all intermediate inputs + the DOM value-added rows),
  A[:, j] = Z[:, j] / x_j (input coefficients, 'euro of input per euro of output'), L = (I - A)^-1 (Leontief inverse,
  same orientation: L[i, j] = total output of i needed per euro of final demand for j).
  Direct + indirect: L = I + A + A^2 + ...; indirect = L - I - A. For i != j the identity term is 0, so
  total L_ij = direct a_ij + indirect. Aggregates use (L - I): the input requirement net of the unit of output itself.

Final-demand columns (ind_use): P3_S13 P3_S14 P3_S15 P51G P5M (discovered from the data and stored in the run record).
Value-added and other rows have c_orig=DOM with ind_ava B2A3G, D1, D21X31, D29X39 (net taxes on production, negative =
subsidies, normal), OP_RES, OP_NRES (zero in industry columns).

Coverage: 50 regions (49 countries + WRL_REST). Africa is represented only by South Africa (ZA) and the rest-of-world
aggregate, so for an Africa-first product most African supply chains are inside WRL_REST and cannot be told apart.

Limitations: industry-level monetary coefficients are not a bill of materials for an HS product; one year; the
proportionality assumption (every output of an industry uses the same input mix) and price differences across users
are inherent to IO tables.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from . import concordance as cc

SOURCE = "ESTAT_FIGARO_II"
DATASET_ID = "ESTAT:NAIO_10_FCP_II4(1.0)"
BASE = "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/naio_10_fcp_ii4/"
CACHE = Path(__file__).resolve().parents[2] / "logs" / "mrio-cache"
UNIT = "euro of input per euro of output"
PRICE_BASIS = "current basic prices, million EUR"
LICENCE = cc.ESTAT_LICENCE
MODIFICATION_NOTE = ("Tereflow derived input coefficients A = Z / x and the Leontief inverse L = (I - A)^-1 from the published "
                     "flows, and ranked suppliers; the published flows themselves are not altered.")
COVERAGE_NOTE = ("FIGARO covers 50 regions: 49 countries and a rest-of-world aggregate (WRL_REST). Africa is covered only by "
                 "South Africa (ZA) and WRL_REST, so supply chains through other African countries are not visible separately. "
                 "This is a material gap for an Africa-first product.")
LIMITATIONS = [
    "Industry-level coefficients are not a bill of materials for an HS product.",
    "Monetary coefficients (million EUR at current basic prices), not physical quantities.",
    "One year only; coefficients change over time.",
    "Proportionality assumption: every product of an industry is assumed to use the same input mix.",
    "OECD ICIO is not integrated (HTTP 403 from this machine); FIGARO is the only source.",
]

INDUSTRIES = cc.FIGARO_INDUSTRIES
FINAL_DEMAND_KNOWN = ["P3_S13", "P3_S14", "P3_S15", "P51G", "P5M"]
VA_ROWS = ["B2A3G", "D1", "D21X31", "D29X39", "OP_NRES", "OP_RES"]

# Eurostat region code -> ISO 3166-1 alpha-3. Written by hand. Eurostat uses EL for Greece and UK for the United Kingdom.
ISO3 = {
    "AL": "ALB", "AR": "ARG", "AT": "AUT", "AU": "AUS", "BE": "BEL", "BG": "BGR", "BR": "BRA", "CA": "CAN", "CH": "CHE",
    "CN": "CHN", "CY": "CYP", "CZ": "CZE", "DE": "DEU", "DK": "DNK", "EE": "EST", "EL": "GRC", "ES": "ESP", "FI": "FIN",
    "FR": "FRA", "HR": "HRV", "HU": "HUN", "ID": "IDN", "IE": "IRL", "IN": "IND", "IT": "ITA", "JP": "JPN", "KR": "KOR",
    "LT": "LTU", "LU": "LUX", "LV": "LVA", "ME": "MNE", "MK": "MKD", "MT": "MLT", "MX": "MEX", "NL": "NLD", "NO": "NOR",
    "PL": "POL", "PT": "PRT", "RO": "ROU", "RS": "SRB", "RU": "RUS", "SA": "SAU", "SE": "SWE", "SI": "SVN", "SK": "SVK",
    "TR": "TUR", "UK": "GBR", "US": "USA", "ZA": "ZAF",
    "WRL_REST": None,  # rest-of-world aggregate: no ISO3 code exists
}
REGIONS = list(ISO3)

DDL = [
    """CREATE TABLE app_pi_io (source VARCHAR2(40) NOT NULL, year NUMBER(4) NOT NULL, country VARCHAR2(10) NOT NULL,
       industry VARCHAR2(10) NOT NULL, output_meur NUMBER, computed_at VARCHAR2(30), payload CLOB,
       PRIMARY KEY (source, year, country, industry))""",
    """CREATE TABLE app_pi_io_meta (k VARCHAR2(80) PRIMARY KEY, v CLOB, updated_at VARCHAR2(30))""",
    """CREATE TABLE app_pi_region (code VARCHAR2(10) PRIMARY KEY, iso3 VARCHAR2(3), name VARCHAR2(200), note VARCHAR2(300))""",
]
TABLES = ["pi_io", "pi_io_meta", "pi_region"]


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


# ---------------------------------------------------------------- download and parse

def url_for(c_dest: str, year: int) -> str:
    return f"{BASE}A...{c_dest}.MIO_EUR.?startPeriod={year}&endPeriod={year}&format=SDMX-CSV"


def download(year: int, regions=REGIONS, log=print, delay: float = 1.5) -> list:
    """One request per destination region, cached as {c_dest}_{year}.csv. Returns fetch infos."""
    out = []
    for r in regions:
        t = time.time()
        info = cc.fetch(url_for(r, year), CACHE / f"{r}_{year}.csv", log, tries=5, delay=5.0)
        out.append(info)
        if not info["cached"]:
            log(f"  downloaded {r} {year} in {time.time() - t:.0f}s")
            time.sleep(delay)
    return out


def read_frames(year: int, regions=REGIONS):
    import pandas as pd
    cols = ["LAST UPDATE", "ind_use", "ind_ava", "c_dest", "c_orig", "TIME_PERIOD", "OBS_VALUE"]
    frames = []
    for r in regions:
        df = pd.read_csv(CACHE / f"{r}_{year}.csv", usecols=cols, dtype={c: "string" for c in cols[:-1]}, keep_default_na=False,
                         na_values={"OBS_VALUE": [""]})
        frames.append(df)
    return pd.concat(frames, ignore_index=True)


def build_matrices(df, regions=REGIONS, industries=INDUSTRIES) -> dict:
    """Long FIGARO rows -> Z (n x n), final demand F (n x regions x fd), value-added rows V (va x n), plus diagnostics.

    n = len(regions) * len(industries); index of (region r, industry k) = r * len(industries) + k.
    Row = supplier (c_orig, ind_ava), column = user (c_dest, ind_use).
    """
    import pandas as pd
    nr, ni = len(regions), len(industries)
    n = nr * ni
    rix = {c: i for i, c in enumerate(regions)}
    iix = {c: i for i, c in enumerate(industries)}
    use = df["ind_use"].astype(str)
    fd_codes = sorted(set(use.unique()) - set(industries))
    fdix = {c: i for i, c in enumerate(fd_codes)}
    va_codes = sorted(set(df.loc[df["c_orig"] == "DOM", "ind_ava"].astype(str).unique()))
    vaix = {c: i for i, c in enumerate(va_codes)}
    o = df["c_orig"].map(rix)
    a = df["ind_ava"].map(iix)
    d = df["c_dest"].map(rix)
    u = df["ind_use"].map(iix)
    f = df["ind_use"].map(fdix)
    va = df["ind_ava"].map(vaix).where(df["c_orig"] == "DOM")
    v = df["OBS_VALUE"].astype(float)
    missing = int(v.isna().sum())
    unknown = {
        "c_orig": sorted(set(df.loc[o.isna() & (df["c_orig"] != "DOM"), "c_orig"].astype(str))),
        "ind_ava": sorted(set(df.loc[a.isna() & (df["c_orig"] != "DOM"), "ind_ava"].astype(str))),
        "c_dest": sorted(set(df.loc[d.isna(), "c_dest"].astype(str))),
    }
    vv = v.fillna(0.0).to_numpy()
    Z = np.zeros((n, n))
    F = np.zeros((n, nr, len(fd_codes)))
    V = np.zeros((len(va_codes), n))
    Vfd = np.zeros((len(va_codes), nr, len(fd_codes)))
    m = (o.notna() & a.notna() & d.notna() & u.notna()).to_numpy()
    rows = (o[m].astype(int) * ni + a[m].astype(int)).to_numpy()
    colz = (d[m].astype(int) * ni + u[m].astype(int)).to_numpy()
    dup = int(pd.Series(rows * n + colz).duplicated().sum())
    np.add.at(Z, (rows, colz), vv[m])
    m = (o.notna() & a.notna() & d.notna() & f.notna()).to_numpy()
    np.add.at(F, ((o[m].astype(int) * ni + a[m].astype(int)).to_numpy(), d[m].astype(int).to_numpy(), f[m].astype(int).to_numpy()), vv[m])
    m = (va.notna() & d.notna() & u.notna()).to_numpy()
    np.add.at(V, (va[m].astype(int).to_numpy(), (d[m].astype(int) * ni + u[m].astype(int)).to_numpy()), vv[m])
    m = (va.notna() & d.notna() & f.notna()).to_numpy()
    np.add.at(Vfd, (va[m].astype(int).to_numpy(), d[m].astype(int).to_numpy(), f[m].astype(int).to_numpy()), vv[m])
    return {"Z": Z, "F": F, "V": V, "Vfd": Vfd, "fd_codes": fd_codes, "va_codes": va_codes, "missing_values": missing,
            "duplicate_cells": dup, "unknown_codes": unknown, "rows_read": int(len(df))}


def leontief(Z: np.ndarray, x: np.ndarray) -> dict:
    """A = Z / x by column (x_j <= 0 -> zero column, flagged), L = (I - A)^-1 in float64."""
    Z = np.asarray(Z, dtype=np.float64)
    x = np.asarray(x, dtype=np.float64)
    bad = ~(x > 0)
    A = np.zeros_like(Z)
    A[:, ~bad] = Z[:, ~bad] / x[~bad]
    L = np.linalg.inv(np.eye(len(x)) - A)
    return {"A": A, "L": L, "zero_output": bad}


def spectral_radius(A: np.ndarray, iters: int = 500, tol: float = 1e-12) -> float:
    """Power iteration on A (A >= 0 assumed). Returns the dominant eigenvalue estimate."""
    v = np.ones(A.shape[0]) / A.shape[0]
    lam = 0.0
    for _ in range(iters):
        w = A @ v
        s = np.abs(w).sum()
        if s == 0:
            return 0.0
        w /= s
        new = float(np.abs(A @ w).sum() / np.abs(w).sum())
        if abs(new - lam) < tol:
            return new
        lam, v = new, w
    return lam


def validate(A: np.ndarray, L: np.ndarray, zero_output: np.ndarray) -> dict:
    n = A.shape[0]
    resid = float(np.abs(L @ (np.eye(n) - A) - np.eye(n)).max())
    neg_a = int((A < 0).sum())
    rho = spectral_radius(np.abs(A)) if n else 0.0
    return {"dimensions": [int(n), int(n)], "columns_with_x_le_0": int(zero_output.sum()),
            "share_columns_x_le_0": round(float(zero_output.mean()), 6) if n else None,
            "negative_coefficients": neg_a, "max_column_sum_A": round(float(A.sum(axis=0).max()), 6),
            "spectral_radius_A": round(rho, 6), "spectral_radius_lt_1": rho < 1,
            "L_min": float(L.min()), "L_nonnegative": bool(L.min() >= -1e-9),
            "L_diag_min": float(np.diag(L).min()), "L_diag_ge_1": bool(np.diag(L).min() >= 1 - 1e-9),
            "inverse_residual_max": resid}


def orientation_check(Z: np.ndarray, regions=REGIONS, industries=INDUSTRIES, country: str = "BE") -> dict:
    ni = len(industries)
    k = {c: i for i, c in enumerate(industries)}

    def world(src, dst):
        return float(Z.reshape(len(regions), ni, len(regions), ni)[:, k[src], :, k[dst]].sum())

    r = regions.index(country)

    def into(src, dst):  # all origins -> country's dst
        return float(Z.reshape(len(regions), ni, len(regions), ni)[:, k[src], r, k[dst]].sum())

    return {"world_B_to_C19": world("B", "C19"), "world_C19_to_B": world("C19", "B"),
            "world_C20_to_A01": world("C20", "A01"), "world_A01_to_C20": world("A01", "C20"),
            "world_C19_to_A01": world("C19", "A01"), "world_A01_to_F": world("A01", "F"),
            f"{country}_C10-12_to_A01": into("C10-12", "A01"), f"{country}_C20_to_A01": into("C20", "A01"),
            f"{country}_C19_to_A01": into("C19", "A01"), f"{country}_D35_to_A01": into("D35", "A01"),
            f"{country}_A01_to_F": into("A01", "F")}


# ---------------------------------------------------------------- payloads

def _label(i: int, regions, industries) -> tuple:
    ni = len(industries)
    return regions[i // ni], industries[i % ni]


def column_payload(j: int, Z, x, A, L, regions=REGIONS, industries=INDUSTRIES, names=None, year=None,
                   top: int = 15, top_groups: int = 12) -> dict:
    """Payload for one using column j = (country, industry)."""
    names = names or {}
    ni, nr = len(industries), len(regions)
    c, k = _label(j, regions, industries)
    xj = float(x[j])
    base = {"source": SOURCE, "dataset": DATASET_ID, "year": year, "country": c, "country_iso3": ISO3.get(c), "industry": k,
            "industry_name": names.get(k), "unit": UNIT, "price_basis": PRICE_BASIS, "output_meur": round(xj, 3)}
    if not xj > 0:
        base.update({"flag": "output_le_0", "note": "No output in this cell; coefficients are not defined.",
                     "direct_top": [], "total_top": [], "by_supplier_country": [], "by_supplier_industry": [],
                     "domestic_share_direct": None, "domestic_share_total": None})
        return base
    a = A[:, j]
    lc = L[:, j].copy()
    req = lc.copy()
    req[j] -= 1.0  # L - I: requirement net of the unit of output itself
    ind = req - a  # indirect = L - I - A

    def ent(i):
        rc, ik = _label(i, regions, industries)
        return {"country": rc, "iso3": ISO3.get(rc), "industry": ik, "industry_name": names.get(ik)}

    direct_top = []
    for i in np.argsort(-a, kind="stable")[:top]:
        if a[i] <= 0:
            break
        e = ent(int(i))
        e.update({"coef": round(float(a[i]), 6), "value_meur": round(float(Z[i, j]), 3),
                  "share_of_output_pct": round(100.0 * float(a[i]), 3), "self": bool(i == j)})
        direct_top.append(e)
    order = np.argsort(-lc, kind="stable")
    total_top = []
    for i in order:
        if i == j:
            continue
        if len(total_top) >= top or lc[i] <= 0:
            break
        e = ent(int(i))
        e.update({"total": round(float(lc[i]), 6), "direct": round(float(a[i]), 6), "indirect": round(float(ind[i]), 6)})
        total_top.append(e)
    a3 = a.reshape(nr, ni)
    r3 = req.reshape(nr, ni)
    bc = [{"country": regions[r], "iso3": ISO3.get(regions[r]), "direct": round(float(a3[r].sum()), 6), "total": round(float(r3[r].sum()), 6)}
          for r in range(nr)]
    bc.sort(key=lambda e: -e["total"])
    bi = [{"industry": industries[i], "industry_name": names.get(industries[i]), "direct": round(float(a3[:, i].sum()), 6),
           "total": round(float(r3[:, i].sum()), 6)} for i in range(ni)]
    bi.sort(key=lambda e: -e["total"])
    rc = regions.index(c)
    sd, st = float(a.sum()), float(req.sum())
    base.update({
        "intermediate_input_share": round(sd, 6),
        "total_requirement": round(st, 6),
        "direct_top": direct_top, "total_top": total_top,
        "by_supplier_country": bc[:top_groups], "by_supplier_industry": bi[:top_groups],
        "domestic_share_direct": round(float(a3[rc].sum()) / sd, 6) if sd > 0 else None,
        "domestic_share_total": round(float(r3[rc].sum()) / st, 6) if st > 0 else None,
        "self_total": round(float(lc[j]), 6),
        "definitions": {"coef": "a_ij = Z_ij / x_j", "total": "L_ij from L = (I - A)^-1", "indirect": "L_ij - a_ij (i != j)",
                        "by_supplier.total": "sum of (L - I) over the group", "domestic_share": "share of the requirement supplied by the same country"},
    })
    return base


# ---------------------------------------------------------------- run

def _names(log=print) -> tuple:
    ind = cc.parse_codelist(cc._text(cc.fetch(cc.SOURCES["ESTAT_IND_USE"]["url"], cc.CACHE / "estat_ind_use.tsv", log)["path"].read_bytes()))
    reg_url = "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/codelist/ESTAT/C_ORIG/latest?format=TSV&lang=en"
    reg = cc.parse_codelist(cc._text(cc.fetch(reg_url, cc.CACHE / "estat_c_orig.tsv", log)["path"].read_bytes()))
    return ind, reg


def latest_year(log=print) -> int:
    """Latest year with data, from the SDMX availability of one region (BE)."""
    import requests
    for y in range(time.gmtime().tm_year, 2009, -1):
        r = requests.get(url_for("BE", y).replace("A...BE.", "A.A01.A01.BE.") , timeout=60)
        if r.status_code == 200 and len(r.content) > 200:
            return y
    raise RuntimeError("no FIGARO year found")


def run(conn, year=None, countries=None, write=True, log=print) -> dict:
    """Download (cached), build Z, x, A, L for one year and store one payload per (country, industry) column.

    The whole matrix is always built (L needs every region); `countries` only limits which columns are written.
    """
    t0 = time.time()
    year = int(year or latest_year(log))
    infos = download(year, log=log)
    t1 = time.time()
    df = read_frames(year)
    last_update = sorted(set(df["LAST UPDATE"].astype(str)))
    years = sorted(set(df["TIME_PERIOD"].astype(str)))
    mats = build_matrices(df)
    del df
    t2 = time.time()
    Z, F, V = mats["Z"], mats["F"], mats["V"]
    x_col = Z.sum(axis=0) + V.sum(axis=0)
    x_row = Z.sum(axis=1) + F.sum(axis=(1, 2))
    diff = x_row - x_col
    rel = np.abs(diff) / np.maximum(np.abs(x_col), 1e-9)
    big = np.argsort(-np.abs(diff))[:5]
    balance = {"x_definition": "column total: intermediate inputs from all origins + DOM rows",
               "total_output_col_meur": round(float(x_col.sum()), 1), "total_output_row_meur": round(float(x_row.sum()), 1),
               "max_abs_diff_meur": round(float(np.abs(diff).max()), 3),
               "max_rel_diff_where_x_gt_1": round(float(rel[np.abs(x_col) > 1].max()), 8) if (np.abs(x_col) > 1).any() else None,
               "largest": [{"country": _label(int(i), REGIONS, INDUSTRIES)[0], "industry": _label(int(i), REGIONS, INDUSTRIES)[1],
                            "x_col": round(float(x_col[i]), 3), "x_row": round(float(x_row[i]), 3)} for i in big]}
    lt = leontief(Z, x_col)
    A, L = lt["A"], lt["L"]
    t3 = time.time()
    val = validate(A, L, lt["zero_output"])
    y_fd = F.sum(axis=(1, 2))
    val["L_times_final_demand_vs_x_max_abs_diff_meur"] = round(float(np.abs(L @ y_fd - x_col).max()), 3)
    val["L_times_final_demand_vs_x_note"] = "L y equals x only if the row and column totals balance; the difference mirrors the balance check"
    orient = orientation_check(Z)
    ind_names, reg_names = _names(log)
    sel = set(countries) if countries else set(REGIONS)
    payloads = []
    for j in range(len(x_col)):
        c, k = _label(j, REGIONS, INDUSTRIES)
        if c in sel:
            payloads.append(column_payload(j, Z, x_col, A, L, names=ind_names, year=year))
    t4 = time.time()
    meta = {"source": SOURCE, "dataset": DATASET_ID, "last_update": last_update, "time_period": years, "year": year,
            "retrieved_at": sorted({i["retrieved_at"] for i in infos}), "files": len(infos),
            "urls_pattern": url_for("{c_dest}", year), "rows_read": mats["rows_read"],
            "missing_values_set_to_0": mats["missing_values"], "duplicate_cells": mats["duplicate_cells"],
            "unknown_codes": mats["unknown_codes"], "regions": REGIONS, "industries": INDUSTRIES,
            "final_demand_codes": mats["fd_codes"], "value_added_codes": mats["va_codes"],
            "value_added_totals_meur": {c: round(float(V[i].sum()), 1) for i, c in enumerate(mats["va_codes"])},
            "balance_check": balance, "validation": val, "orientation_check": orient,
            "unit": UNIT, "price_basis": PRICE_BASIS, "licence": LICENCE, "modification_note": MODIFICATION_NOTE,
            "coverage_note": COVERAGE_NOTE, "limitations": LIMITATIONS,
            "blockers": ["OECD ICIO returned HTTP 403 from this machine; not integrated. Unblock: download the ICIO zip by hand into a folder and add a loader writing source='OECD_ICIO'."],
            "columns_written": len(payloads),
            "timings_s": {"download": round(t1 - t0, 1), "parse": round(t2 - t1, 1), "inverse": round(t3 - t2, 1), "payloads": round(t4 - t3, 1)}}
    if write:
        now = cc._now()
        cur = conn.cursor()
        if countries:
            cur.executemany("DELETE FROM app_pi_io WHERE source = :1 AND year = :2 AND country = :3", [(SOURCE, year, c) for c in sel])
        else:
            cur.execute("DELETE FROM app_pi_io WHERE source = :1 AND year = :2", [SOURCE, year])
        cur = conn.cursor()
        cur.setinputsizes(None, None, None, None, None, None, __import__("oracledb").DB_TYPE_CLOB)
        rows = [(SOURCE, year, p["country"], p["industry"], p["output_meur"], now, json.dumps(p, separators=(",", ":"))) for p in payloads]
        for i in range(0, len(rows), 500):
            cur.executemany("INSERT INTO app_pi_io (source, year, country, industry, output_meur, computed_at, payload) VALUES (:1, :2, :3, :4, :5, :6, :7)",
                            rows[i:i + 500])
        cur = conn.cursor()
        cur.execute("DELETE FROM app_pi_region")
        cur.executemany("INSERT INTO app_pi_region (code, iso3, name, note) VALUES (:1, :2, :3, :4)",
                        [(r, ISO3[r], reg_names.get(r), "rest-of-world aggregate, no ISO3 code" if ISO3[r] is None else None) for r in REGIONS])
        meta["timings_s"]["total"] = round(time.time() - t0, 1)
        k = f"{SOURCE}:{year}"
        cur.execute("DELETE FROM app_pi_io_meta WHERE k IN (:1, 'latest')", [k])
        cur = conn.cursor()
        cur.setinputsizes(None, __import__("oracledb").DB_TYPE_CLOB, None)
        cur.executemany("INSERT INTO app_pi_io_meta (k, v, updated_at) VALUES (:1, :2, :3)",
                        [(k, json.dumps(meta), now), ("latest", json.dumps({"source": SOURCE, "year": year, "key": k}), now)])
        conn.commit()
        cc.write_sources(conn, {"ESTAT_NAIO_10_FCP_II4": {
            "name": "Eurostat FIGARO inter-country IO table, industry by industry (naio_10_fcp_ii4)", "url": url_for("{c_dest}", year),
            "version": f"{DATASET_ID} LAST UPDATE {', '.join(last_update)}", "direction": "row = supplier (c_orig, ind_ava), column = user (c_dest, ind_use)",
            "retrieved_at": max(i["retrieved_at"] for i in infos), "rows": mats["rows_read"], "sha256": None,
            "licence": LICENCE, "note": json.dumps({"modification_note": MODIFICATION_NOTE, "coverage_note": COVERAGE_NOTE})}})
    meta["timings_s"]["total"] = round(time.time() - t0, 1)
    return {"meta": meta, "payloads": {(p["country"], p["industry"]): p for p in payloads}}
