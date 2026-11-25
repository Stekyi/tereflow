import csv
import zipfile

import numpy as np
import pytest

from tereflow_oracle import icio


@pytest.fixture(autouse=True)
def small_tables(monkeypatch):
    monkeypatch.setattr(icio, "MIN_COLUMNS", 10)


def make_icio(path, countries=("AAA", "BBB", "CCC"), inds=("A01", "C26", "D35", "F"), seed=3, break_va=False, swap=False, fd_names=("HFCE", "GFCF"), n_extra=0):
    rng = np.random.default_rng(seed)
    codes = [f"{c}_{i}" for c in countries for i in inds]
    n = len(codes)
    Z = rng.uniform(0, 5, (n, n)) * (rng.random((n, n)) < 0.7)
    F = rng.uniform(5, 40, (n, len(countries) * len(fd_names)))
    va = rng.uniform(10, 30, n)
    tax = rng.uniform(0, 3, n)
    x_col = Z.sum(axis=0) + va + tax                       # output from the cost side
    x_row = Z.sum(axis=1) + F.sum(axis=1)                  # output from the use side
    # make the two sides agree: scale final demand so that row output equals column output
    F = F * ((x_col - Z.sum(axis=1)) / F.sum(axis=1))[:, None]
    x_row = Z.sum(axis=1) + F.sum(axis=1)
    fd_cols = [f"{c}_{f}" for c in countries for f in fd_names]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([""] + codes + fd_cols + ["OUT"])
        for i, code in enumerate(codes):
            w.writerow([code] + list(Z[i]) + list(F[i]) + [x_row[i]])
        w.writerow(["TAXSUB"] + list(tax) + [0] * len(fd_cols) + [tax.sum()])
        if not break_va:
            w.writerow(["VA"] + list(va) + [0] * len(fd_cols) + [va.sum()])
        w.writerow(["OUT"] + list(x_col) + [0] * len(fd_cols) + [x_col.sum()])
    return codes, Z, x_col


def test_good_file_passes_and_matches_hand_calculation(tmp_path):
    p = tmp_path / "ICIO_2020.csv"
    codes, Z, x = make_icio(p)
    m = icio.read_matrix(str(p), log=lambda *a: None)
    assert m["codes"] == codes and np.allclose(m["Z"], Z)
    bal = icio.check_balance(m)
    assert bal["ok"], bal["problems"]
    assert bal["column_balance_max_rel"] < 1e-9 and bal["row_balance_max_rel"] < 1e-9


def test_run_file_builds_payloads_with_correct_orientation(tmp_path):
    p = tmp_path / "ICIO_2020.csv"
    codes, Z, x = make_icio(p)
    rep = icio.run_file(None, str(p), "ICIO_2020.csv", write=False, log=lambda *a: None)
    assert rep["columns"] == len(codes) and rep["meta"]["year"] == 2020
    A = Z / x
    from tereflow_oracle import mrio
    L = np.linalg.inv(np.eye(len(x)) - A)
    assert rep["meta"]["validation"]["spectral_radius_lt_1"]
    # first column's direct requirement equals the hand-made coefficient, and total equals the Leontief column
    j = 0
    lt = mrio.leontief(Z, x)
    p0 = mrio.column_payload(j, Z, x, lt["A"], lt["L"], regions=["AAA", "BBB", "CCC"], industries=["A01", "C26", "D35", "F"], year=2020, iso3={})
    assert p0["intermediate_input_share"] == pytest.approx(float(A[:, j].sum()), abs=1e-5)
    assert p0["total_requirement"] == pytest.approx(float((L[:, j]).sum() - 1.0), abs=1e-5)


def test_zip_is_read(tmp_path):
    p = tmp_path / "x.csv"
    make_icio(p)
    z = tmp_path / "ICIO2023_2020.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.write(p, "2020_SML.csv")
    m = icio.read_matrix(str(z), log=lambda *a: None)
    assert m["file"] == "2020_SML.csv" and icio.year_of("ICIO2023_2020.zip") == 2020


def test_missing_value_added_row_is_refused(tmp_path):
    p = tmp_path / "ICIO_2020.csv"
    make_icio(p, break_va=True)
    m = icio.read_matrix(str(p), log=lambda *a: None)
    bal = icio.check_balance(m)
    assert not bal["ok"] and "do not add up" in " ".join(bal["problems"])


def test_transposed_table_is_refused(tmp_path):
    p = tmp_path / "ICIO_2020.csv"
    codes, Z, x = make_icio(p)
    rows = list(csv.reader(open(p)))
    head, body = rows[0], rows[1:]
    n = len(codes)
    q = tmp_path / "ICIO_2021.csv"
    # swap the roles: write Z transposed with the same labels
    with open(q, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(head)
        for i, r in enumerate(body[:n]):
            vals = [float(rows[1 + k][1 + i]) for k in range(n)]
            w.writerow([r[0]] + vals + r[1 + n:])
        for r in body[n:]:
            w.writerow(r)
    m = icio.read_matrix(str(q), log=lambda *a: None)
    assert not icio.check_balance(m)["ok"]


def test_not_an_icio_file_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(icio, "MIN_COLUMNS", 100)
    p = tmp_path / "ICIO_2020.csv"
    p.write_text("a,b,c\n1,2,3\n")
    with pytest.raises(icio.IcioRefused):
        icio.read_matrix(str(p), log=lambda *a: None)


def test_year_must_be_in_the_name(tmp_path):
    p = tmp_path / "icio.csv"
    make_icio(p)
    with pytest.raises(icio.IcioRefused, match="year"):
        icio.run_file(None, str(p), "icio.csv", write=False, log=lambda *a: None)


def test_unequal_row_and_column_lists_are_refused(tmp_path):
    p = tmp_path / "ICIO_2020.csv"
    make_icio(p)
    lines = open(p).read().splitlines()
    del lines[3]                                  # drop one supplying row
    open(p, "w").write("\n".join(lines))
    with pytest.raises(icio.IcioRefused, match="rows"):
        icio.read_matrix(str(p), log=lambda *a: None)


def test_nothing_is_written_on_refusal(tmp_path):
    class Conn:
        def cursor(self):
            raise AssertionError("the database must not be touched for a refused file")
    p = tmp_path / "ICIO_2020.csv"
    make_icio(p, break_va=True)
    with pytest.raises(icio.IcioRefused):
        icio.run_file(Conn(), str(p), "ICIO_2020.csv", write=True, log=lambda *a: None)
