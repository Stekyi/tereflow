"""OECD Inter-Country Input-Output (ICIO) tables: validate an uploaded file and run the same production-network
calculation as for FIGARO.

Why an upload: the OECD site refused downloads from the machine that built Tereflow, so an operator downloads the zip
from OECD (https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html), and uploads it in Admin.
The Worker only stores it. This module reads it, checks it, and stores results under source='OECD_ICIO'.

Layout (OECD ICIO documentation: each yearly file is one wide matrix, CSV or a zipped CSV):
  rows     = supplying country-industry ("AUS_A01_02", "CHN_C26", ...) plus value-added rows (VA, TAXSUB) and the total row OUT
  columns  = using country-industry (same codes) followed by final-demand columns ("AUS_HFCE", "AUS_NPISH", "AUS_GGFC",
             "AUS_GFCF", "AUS_INVNT", "AUS_DPABR") and OUT, the total output / total use
So Z[i, j] = purchases of using column j from supplying row i, as in the FIGARO engine.
Nothing about the layout is trusted: the labels are parsed, the code lists are taken from the file itself, the
orientation is tested (output of each industry must equal the sum of its input column, and the row total must equal
the intermediate sales plus final demand), and anything that does not balance within tolerance is REFUSED with a reason.
No row of the file is ever altered. A file that fails any check writes nothing.

Not verified against a real ICIO file in the environment that built this (the site returned HTTP 403). The first real
upload is the test; the report below says exactly what was and was not found.
"""
from __future__ import annotations

import csv
import io
import re
import time
import zipfile
from typing import Optional

import numpy as np

from . import mrio

SOURCE = "OECD_ICIO"
UNIT = "euro-equivalent: US dollar input per US dollar of output"
PRICE_BASIS = "current prices, million US dollars (OECD ICIO)"
FD_SUFFIXES = ("HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR", "FD_", "FD")
VA_LABELS = ("VA", "TAXSUB", "TLS", "VALU", "GVA", "TAX")
TOTAL_LABELS = ("OUT", "OUTPUT", "TOTAL", "TOT")
CELL = re.compile(r"^([A-Z0-9]{2,6})_([A-Za-z0-9_]+)$")
BALANCE_TOL = 1e-3          # relative, on industries with output above MIN_OUT
MIN_OUT = 1.0               # million
MIN_COLUMNS = 100           # a real ICIO table has thousands; fewer means this is not one
MAX_BYTES = 1_500_000_000
LICENCE = ("OECD Inter-Country Input-Output tables: use is subject to the OECD Terms and Conditions "
           "(https://www.oecd.org/en/about/terms-conditions.html). The operator who uploads the file is responsible for having "
           "the right to use it. Source must be acknowledged: OECD (year), Inter-Country Input-Output Database.")
LICENCE_STATE = "not verified by Tereflow: the OECD site could not be read from the build environment"


class IcioRefused(Exception):
    """The file is not a usable ICIO table. The message is shown to the operator."""


def open_text(path: str):
    """Open a CSV, or the first CSV inside a zip. Returns (text stream, name used)."""
    if path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if not names:
            raise IcioRefused("The zip holds no .csv file.")
        names.sort(key=lambda n: z.getinfo(n).file_size, reverse=True)
        return io.TextIOWrapper(z.open(names[0]), encoding="utf-8-sig", newline=""), names[0]
    return open(path, "r", encoding="utf-8-sig", newline=""), path


def year_of(name: str) -> Optional[int]:
    m = re.findall(r"(?<!\d)((?:19|20)\d{2})(?!\d)", name)
    return int(m[-1]) if m else None


def classify_columns(header: list) -> dict:
    """Split header labels into industry columns, final-demand columns and the total column. Returns indexes."""
    ind, fd, total, other = [], [], None, []
    for k, lab in enumerate(header):
        lab = (lab or "").strip()
        if k == 0:
            continue
        if lab.upper() in TOTAL_LABELS:
            total = k
            continue
        m = CELL.match(lab)
        if not m:
            other.append(lab)
            continue
        suffix = m.group(2)
        if suffix.upper().split("_")[0] in FD_SUFFIXES or suffix.upper() in FD_SUFFIXES:
            fd.append(k)
        else:
            ind.append(k)
    return {"ind": ind, "fd": fd, "total": total, "other": other}


def read_matrix(path: str, log=print) -> dict:
    """Parse the file into arrays. Raises IcioRefused on any structural problem."""
    fh, used = open_text(path)
    try:
        sniff = fh.read(4096)
        fh.seek(0)
        delim = ";" if sniff.count(";") > sniff.count(",") else ","
        rdr = csv.reader(fh, delimiter=delim)
        try:
            header = next(rdr)
        except StopIteration:
            raise IcioRefused("The file is empty.")
        cols = classify_columns(header)
        if len(cols["ind"]) < MIN_COLUMNS:
            raise IcioRefused(f"Found only {len(cols['ind'])} country-industry columns (labels like AUS_C26). This does not look like an ICIO table.")
        if cols["total"] is None:
            raise IcioRefused("No total column (OUT) in the header, so output cannot be checked.")
        ind_idx, fd_idx = cols["ind"], cols["fd"]
        col_codes = [header[k].strip() for k in ind_idx]
        rows_ind, rows_other = {}, {}
        Z, F, X, V = [], [], [], {}
        out_row = None
        for line in rdr:
            if not line or not line[0].strip():
                continue
            lab = line[0].strip()

            def num(k):
                v = line[k].strip() if k < len(line) else ""
                return float(v) if v not in ("", "NA", "..", "-") else 0.0
            if lab.upper() in TOTAL_LABELS:
                out_row = np.array([num(k) for k in ind_idx])
            elif lab in col_codes and CELL.match(lab):
                rows_ind[lab] = len(Z)
                Z.append([num(k) for k in ind_idx])
                F.append([num(k) for k in fd_idx])
                X.append(num(cols["total"]))
            else:
                V[lab] = np.array([num(k) for k in ind_idx])
    finally:
        fh.close()
    n = len(col_codes)
    if len(Z) != n or set(rows_ind) != set(col_codes):
        raise IcioRefused(f"The supplying rows ({len(Z)}) do not match the using columns ({n}). Row and column country-industry lists must be identical.")
    order = [rows_ind[c] for c in col_codes]
    Zm = np.array(Z, dtype=float)[order]
    Fm = np.array(F, dtype=float)[order] if fd_idx else np.zeros((n, 0))
    xrow = np.array(X, dtype=float)[order]
    if out_row is None:
        raise IcioRefused("No total row (OUT), so output cannot be checked.")
    if not V:
        raise IcioRefused("No value-added rows (VA and tax rows) were found.")
    log(f"{n} country-industries, {len(fd_idx)} final-demand columns, value-added rows {sorted(V)}")
    return {"codes": col_codes, "Z": Zm, "F": Fm, "x_row": xrow, "x_col": out_row, "V": V, "header_other": cols["other"], "file": used,
            "fd_codes": [header[k].strip() for k in fd_idx]}


def check_balance(m: dict) -> dict:
    """The tests that decide whether the file is trusted. Returns the report; the caller refuses if `ok` is False."""
    Z, x_row, x_col = m["Z"], m["x_row"], m["x_col"]
    colsum = Z.sum(axis=0) + sum(v for v in m["V"].values())
    big = x_col > MIN_OUT
    rel_col = np.abs(colsum[big] - x_col[big]) / x_col[big]
    rowsum = Z.sum(axis=1) + m["F"].sum(axis=1)
    bigr = x_row > MIN_OUT
    rel_row = np.abs(rowsum[bigr] - x_row[bigr]) / x_row[bigr]
    sym = np.abs(x_row - x_col)[big].max() / max(float(x_col[big].max()), 1.0) if big.any() else 1.0
    neg = int((Z < 0).sum())
    rep = {"n": len(x_col), "industries_with_output": int(big.sum()),
           "column_balance_max_rel": round(float(rel_col.max()), 8) if rel_col.size else None,
           "column_balance_median_rel": round(float(np.median(rel_col)), 10) if rel_col.size else None,
           "row_balance_max_rel": round(float(rel_row.max()), 8) if rel_row.size else None,
           "row_balance_median_rel": round(float(np.median(rel_row)), 10) if rel_row.size else None,
           "row_vs_col_total_max_rel": round(float(sym), 8), "negative_intermediate_cells": neg,
           "unrecognised_header_labels": m["header_other"][:10]}
    problems = []
    if rep["column_balance_max_rel"] is None or rep["column_balance_max_rel"] > BALANCE_TOL:
        problems.append(f"Input columns do not add up to output (worst gap {rep['column_balance_max_rel']}, allowed {BALANCE_TOL}). Either the value-added rows are not all present or the table is not an ICIO table.")
    if rep["row_balance_max_rel"] is None or rep["row_balance_max_rel"] > BALANCE_TOL:
        problems.append(f"Rows do not add up to total use (worst gap {rep['row_balance_max_rel']}). Rows and columns may be swapped, or final-demand columns are missing.")
    if sym > BALANCE_TOL:
        problems.append("Output read down the columns differs from output read along the rows.")
    if neg > 0.001 * Z.size:
        problems.append(f"{neg} negative intermediate flows, far too many for an input-output table.")
    rep["ok"] = not problems
    rep["problems"] = problems
    return rep


def split_codes(codes: list) -> tuple:
    """Country list and industry list, from the file's own labels (CODE_INDUSTRY), in first-seen order."""
    countries, industries = [], []
    for c in codes:
        co, ind = CELL.match(c).group(1), CELL.match(c).group(2)
        if co not in countries:
            countries.append(co)
        if ind not in industries:
            industries.append(ind)
    return countries, industries


def to_grid(m: dict) -> tuple:
    """Re-index Z, x onto a complete country x industry grid. Missing combinations stay zero and are counted."""
    countries, industries = split_codes(m["codes"])
    ci = {c: i for i, c in enumerate(countries)}
    ii = {k: i for i, k in enumerate(industries)}
    n = len(countries) * len(industries)
    pos = np.full(len(m["codes"]), -1)
    for k, code in enumerate(m["codes"]):
        co, ind = CELL.match(code).group(1), CELL.match(code).group(2)
        pos[k] = ci[co] * len(industries) + ii[ind]
    Z = np.zeros((n, n))
    Z[np.ix_(pos, pos)] = m["Z"]
    x = np.zeros(n)
    x[pos] = m["x_col"]
    return Z, x, countries, industries, int(n - len(m["codes"]))


def run_file(conn, path: str, name: str, write: bool = True, log=print) -> dict:
    """Validate and, if trusted, compute and store. Returns a report; raises IcioRefused with the reason otherwise."""
    t0 = time.time()
    year = year_of(name)
    if year is None:
        raise IcioRefused("The year could not be read from the file name (for example 2020_SML.csv or ICIO2023_2020.zip).")
    m = read_matrix(path, log)
    bal = check_balance(m)
    if not bal["ok"]:
        raise IcioRefused(" ".join(bal["problems"]))
    Z, x, countries, industries, padded = to_grid(m)
    lt = mrio.leontief(Z, x)
    A, L = lt["A"], lt["L"]
    val = mrio.validate(A, L, lt["zero_output"])
    if not val["spectral_radius_lt_1"] or not val["L_nonnegative"]:
        raise IcioRefused(f"The Leontief inverse failed its checks (spectral radius {val['spectral_radius_A']}, nonnegative {val['L_nonnegative']}).")
    payloads = []
    iso = {c: (c if len(c) == 3 and c.isalpha() else None) for c in countries}
    for j in range(len(x)):
        p = mrio.column_payload(j, Z, x, A, L, regions=countries, industries=industries, year=year, iso3=iso)
        p.update({"source": SOURCE, "dataset": f"OECD ICIO {year}", "unit": UNIT, "price_basis": PRICE_BASIS})
        payloads.append(p)
    meta = {"source": SOURCE, "year": year, "file": name, "file_inside": m["file"], "countries": countries, "industries": industries,
            "industry_codes_are_oecd": True, "padded_cells": padded, "balance_check": bal, "validation": val, "unit": UNIT, "price_basis": PRICE_BASIS,
            "licence": LICENCE, "licence_state": LICENCE_STATE, "final_demand_codes": m["fd_codes"], "value_added_rows": sorted(m["V"]),
            "coverage_note": (f"{len(countries)} countries or regions as labelled in the file. Industry codes are the OECD ICIO list, not FIGARO NACE codes, so the HS to industry bridge "
                              "does not apply to them yet: results are available by country and industry code only."),
            "limitations": mrio.LIMITATIONS[:4] + ["Not verified against an OECD reference file in the environment that built this loader."],
            "modification_note": mrio.MODIFICATION_NOTE, "seconds": round(time.time() - t0, 1)}
    if write:
        import json
        now = mrio.cc._now()
        cur = conn.cursor()
        cur.execute("DELETE FROM app_pi_io WHERE source = :1 AND year = :2", [SOURCE, year])
        cur = conn.cursor()
        cur.setinputsizes(None, None, None, None, None, None, __import__("oracledb").DB_TYPE_CLOB)
        rows = [(SOURCE, year, p["country"], p["industry"], p["output_meur"], now, json.dumps(p, separators=(",", ":"))) for p in payloads]
        for i in range(0, len(rows), 500):
            cur.executemany("INSERT INTO app_pi_io (source, year, country, industry, output_meur, computed_at, payload) VALUES (:1, :2, :3, :4, :5, :6, :7)", rows[i:i + 500])
        k = f"{SOURCE}:{year}"
        cur = conn.cursor()
        cur.execute("DELETE FROM app_pi_io_meta WHERE k = :1", [k])
        cur.setinputsizes(None, __import__("oracledb").DB_TYPE_CLOB, None)
        cur.execute("INSERT INTO app_pi_io_meta (k, v, updated_at) VALUES (:1, :2, :3)", [k, json.dumps(meta), now])
        conn.commit()
    return {"meta": meta, "columns": len(payloads)}


# ---------------------------------------------------------------- queue in R2

PENDING, DONE, REJECTED = "icio-inbox/pending/", "icio-inbox/done/", "icio-inbox/rejected/"


def process_queue(conn, dry_run: bool = False, log=print) -> int:
    """Take uploaded ICIO files from R2, check and load each, and move it to done/ or rejected/ with the reason. Returns 0 on success."""
    import os
    import tempfile
    from .inbox import _s3
    s3 = _s3()
    bucket = os.environ.get("S3_BUCKET", "tereflow-media")
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket=bucket, Prefix=PENDING).get("Contents", []) if o["Key"] != PENDING]
    if not keys:
        log("no ICIO files waiting")
        return 0
    failed = 0
    for key in keys:
        name = key[len(PENDING):]
        log(f"{name}: downloading")
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, name)
            s3.download_file(bucket, key, path)
            try:
                rep = run_file(conn, path, name, write=not dry_run, log=log)
                log(f"{name}: loaded {rep['columns']} columns, year {rep['meta']['year']}")
                dest, reason = DONE, None
            except IcioRefused as e:
                log(f"{name}: REFUSED: {e}")
                dest, reason = REJECTED, str(e)
                failed += 1
            except Exception as e:  # a crash is also a refusal: nothing was committed
                log(f"{name}: FAILED: {e}")
                dest, reason = REJECTED, f"Could not be processed: {e}"
                failed += 1
        if dry_run:
            continue
        if reason:
            s3.put_object(Bucket=bucket, Key=REJECTED + name + ".reason.txt", Body=reason.encode("utf-8"))
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=dest + name)
        s3.delete_object(Bucket=bucket, Key=key)
    return 1 if failed else 0
