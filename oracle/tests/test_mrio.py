import numpy as np
import pandas as pd
import pytest

from tereflow_oracle import mrio


def test_iso3_map_covers_all_50_regions():
    assert len(mrio.REGIONS) == 50
    assert mrio.ISO3["EL"] == "GRC" and mrio.ISO3["UK"] == "GBR" and mrio.ISO3["ZA"] == "ZAF"
    assert mrio.ISO3["WRL_REST"] is None
    iso = [v for v in mrio.ISO3.values() if v]
    assert len(iso) == 49 and len(set(iso)) == 49 and all(len(v) == 3 and v.isupper() for v in iso)


def _three_sector():
    # columns are users, rows are suppliers; x_j is the column total (inputs + value added)
    Z = np.array([[10.0, 20.0, 0.0],
                  [30.0, 0.0, 40.0],
                  [0.0, 10.0, 20.0]])
    x = np.array([100.0, 200.0, 100.0])
    return Z, x


def test_three_sector_direct_and_total_by_hand():
    Z, x = _three_sector()
    r = mrio.leontief(Z, x)
    A, L = r["A"], r["L"]
    # A by hand: column j divided by x_j
    assert np.allclose(A, [[0.1, 0.1, 0.0], [0.3, 0.0, 0.4], [0.0, 0.05, 0.2]])
    # L equals the power series I + A + A^2 + ...
    S, P = np.eye(3), np.eye(3)
    for _ in range(200):
        P = P @ A
        S = S + P
    assert np.allclose(L, S)
    # (I - A) L = I
    assert np.allclose((np.eye(3) - A) @ L, np.eye(3))
    # direct + indirect split without double counting: for i != j, L_ij = a_ij + indirect_ij and indirect >= 0
    ind = L - np.eye(3) - A
    assert (ind >= -1e-12).all()
    # supplier 3 sells nothing directly to user 1 (a_31 = 0) but is needed indirectly via sector 2:
    # first-round indirect = sum_k a_3k a_k1 = a_32 * a_21 = 0.05 * 0.3 = 0.015
    assert A[2, 0] == 0 and L[2, 0] > 0
    assert (A @ A)[2, 0] == pytest.approx(0.015)
    v = mrio.validate(A, L, r["zero_output"])
    assert v["spectral_radius_lt_1"] and v["L_nonnegative"] and v["L_diag_ge_1"] and v["dimensions"] == [3, 3]


def test_zero_output_column_is_zero_and_flagged():
    Z = np.array([[1.0, 0.0], [2.0, 0.0]])
    r = mrio.leontief(Z, np.array([10.0, 0.0]))
    assert r["zero_output"].tolist() == [False, True]
    assert (r["A"][:, 1] == 0).all()
    assert mrio.validate(r["A"], r["L"], r["zero_output"])["columns_with_x_le_0"] == 1


def test_spectral_radius_power_iteration():
    A = np.array([[0.2, 0.3], [0.4, 0.1]])
    assert mrio.spectral_radius(A) == pytest.approx(max(abs(np.linalg.eigvals(A))), rel=1e-6)


def _long_rows():
    """Tiny FIGARO-shaped long table: 2 regions x 2 industries, one final demand column, DOM value-added rows."""
    regions, inds = ["AA", "BB"], ["X1", "X2"]
    rows = []
    # Z[(supplier), (user)] values chosen so every cell is distinct: value = 1000*o + 100*a + 10*d + u (1-based)
    for oi, o in enumerate(regions):
        for ai, a in enumerate(inds):
            for di, d in enumerate(regions):
                for ui, u in enumerate(inds):
                    rows.append((u, a, d, o, float(1000 * (oi + 1) + 100 * (ai + 1) + 10 * (di + 1) + (ui + 1))))
                rows.append(("P3_S14", a, d, o, 5.0))
    for d in regions:
        for u in inds + ["P3_S14"]:
            rows.append((u, "B2A3G", d, "DOM", 7.0))
            rows.append((u, "D29X39", d, "DOM", -1.0))
    df = pd.DataFrame(rows, columns=["ind_use", "ind_ava", "c_dest", "c_orig", "OBS_VALUE"])
    return df, regions, inds


def test_build_matrices_orientation_row_supplier_column_user():
    df, regions, inds = _long_rows()
    m = mrio.build_matrices(df, regions, inds)
    Z = m["Z"]
    # supplier (BB, X1) -> user (AA, X2): o=2, a=1, d=1, u=2 -> 2112, at row 1*2+0=2, column 0*2+1=1
    assert Z[2, 1] == 2112.0
    assert Z[1, 2] == 1221.0  # supplier (AA, X2) -> user (BB, X1)
    assert m["fd_codes"] == ["P3_S14"] and m["va_codes"] == ["B2A3G", "D29X39"]
    assert m["V"].sum(axis=0).tolist() == [6.0, 6.0, 6.0, 6.0]
    assert m["F"].sum() == 5.0 * 8
    assert m["missing_values"] == 0 and m["duplicate_cells"] == 0


def test_column_payload_shapes_and_split():
    df, regions, inds = _long_rows()
    m = mrio.build_matrices(df, regions, inds)
    x = m["Z"].sum(axis=0) + m["V"].sum(axis=0)
    r = mrio.leontief(m["Z"], x)
    # scale Z down so A is productive for the toy example
    Z = m["Z"] / 10.0
    r = mrio.leontief(Z, x)
    p = mrio.column_payload(1, Z, x, r["A"], r["L"], regions, inds, names={"X1": "one"}, year=2024, top=3, top_groups=2)
    assert p["country"] == "AA" and p["industry"] == "X2" and p["unit"] == mrio.UNIT
    assert len(p["direct_top"]) == 3 and len(p["total_top"]) == 3 and len(p["by_supplier_country"]) == 2
    assert all(not (e["country"] == "AA" and e["industry"] == "X2") for e in p["total_top"])
    for e in p["total_top"]:
        assert e["total"] == pytest.approx(e["direct"] + e["indirect"], abs=2e-6)
    a = r["A"][:, 1]
    assert p["intermediate_input_share"] == pytest.approx(a.sum(), abs=1e-6)
    assert p["domestic_share_direct"] == pytest.approx(a[:2].sum() / a.sum(), abs=1e-6)
    assert p["direct_top"][0]["coef"] == pytest.approx(a.max(), abs=1e-6)
    assert p["direct_top"][0]["share_of_output_pct"] == pytest.approx(100 * a.max(), abs=1e-3)


def test_column_payload_zero_output_has_no_invented_numbers():
    Z = np.zeros((2, 2))
    x = np.array([0.0, 0.0])
    r = mrio.leontief(Z, x)
    p = mrio.column_payload(0, Z, x, r["A"], r["L"], ["AA"], ["X1", "X2"])
    assert p["flag"] == "output_le_0" and p["domestic_share_direct"] is None and p["direct_top"] == []


@pytest.mark.skipif(not (mrio.CACHE / "BE_2024.csv").exists(), reason="FIGARO BE file not cached")
def test_real_belgium_file_orientation():
    df = mrio.read_frames(2024, ["BE"])
    m = mrio.build_matrices(df)
    o = mrio.orientation_check(m["Z"])
    ni, k = len(mrio.INDUSTRIES), {c: i for i, c in enumerate(mrio.INDUSTRIES)}
    b = mrio.REGIONS.index("BE")
    assert m["Z"][b * ni + k["C10-12"], b * ni + k["A01"]] == pytest.approx(2861.624, abs=1e-3)   # Belgian food/feed sold to Belgian agriculture
    assert o["BE_C10-12_to_A01"] >= 2861.6                                                         # all origins, so it also counts imports
    assert o["BE_C20_to_A01"] > 20 * o["BE_A01_to_F"]
    assert o["BE_A01_to_F"] < 20
    assert set(m["fd_codes"]) == set(mrio.FINAL_DEMAND_KNOWN)
    assert m["unknown_codes"] == {"c_orig": [], "ind_ava": [], "c_dest": []}
