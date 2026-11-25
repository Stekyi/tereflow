"""Structural gravity (PPML) by HS chapter, with importer and exporter fixed effects.

What it is: for one HS chapter and year, E[trade_ij] = exp(importer_i + exporter_j + b1*ln(distance) + b2*contiguity + b3*common language
+ b4*colonial tie). Fixed effects absorb each country's size and its multilateral resistance (the approach of Anderson and van Wincoop, in the
fixed-effects form used in the ESCAP guide). Poisson pseudo-maximum likelihood is used so zero flows stay in and heteroskedasticity does not bias
the estimate (Santos Silva and Tenreyro). The source papers could not be retrieved here, so this follows the standard specification and is not yet
checked against them.

What it is not: the fitted value is the trade the model expects between a pair given sizes and trade costs. It is an estimate of trade potential,
kept apart from observed imports. A gap between the two is not unmet demand and is not a forecast.

Validation: a random fifth of pairs is held out, the model is fitted on the rest, and held-out pairs are predicted. The same pairs are predicted by a
no-trade-cost baseline (importer total times exporter share), and both errors are reported.
"""
from __future__ import annotations

import json
import time
from typing import Optional

import numpy as np

from . import markets

GRAVITY_VERSION = "grav-1"
SEED = 20
HOLDOUT = 0.2
MIN_PAIRS = 150
MIN_POSITIVE = 40
TOP_PER_IMPORTER = 10
MIN_PREDICTED_USD = 100_000

# CEPII GeoDist uses some older ISO3 codes.
CEPII_TO_ISO3 = {"ROM": "ROU", "ZAR": "COD", "TMP": "TLS"}

DDL = [
    """CREATE TABLE app_pi_geo (iso_o VARCHAR2(3) NOT NULL, iso_d VARCHAR2(3) NOT NULL, dist NUMBER, distw NUMBER, contig NUMBER, comlang NUMBER, colony NUMBER,
       CONSTRAINT app_pi_geo_pk PRIMARY KEY (iso_o, iso_d))""",
    """CREATE TABLE app_pi_gravity (chapter VARCHAR2(2) PRIMARY KEY, year NUMBER, version VARCHAR2(12), computed_at VARCHAR2(30), payload CLOB)""",
]
TABLES = ["pi_geo", "pi_gravity"]

SOURCE_NOTE = {
    "name": "CEPII GeoDist (Mayer and Zignago, 2011)", "url": "https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=6",
    "licence": "Etalab Open Licence 2.0 (as stated on the CEPII page, retrieved 2026-11-24): reuse including commercial is allowed with attribution.",
    "terms": "dist = simple distance in km between the most populated cities; contig, comlang_off (common official language), colony (ever in a colonial relationship).",
}


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


def load_geo_file(path: str) -> list:
    import pandas as pd
    df = pd.read_excel(path)
    for col in ("dist", "distw", "contig", "comlang_off", "colony"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["dist", "contig", "comlang_off", "colony"])
    out = []
    for r in df.itertuples(index=False):
        o, d = CEPII_TO_ISO3.get(r.iso_o, r.iso_o), CEPII_TO_ISO3.get(r.iso_d, r.iso_d)
        if o == d:
            continue
        out.append((o, d, float(r.dist), None if r.distw != r.distw else float(r.distw), int(r.contig), int(r.comlang_off), int(r.colony)))
    return out


def store_geo(conn, rows: list) -> int:
    cur = conn.cursor()
    cur.execute("DELETE FROM app_pi_geo")
    cur.executemany("INSERT INTO app_pi_geo (iso_o, iso_d, dist, distw, contig, comlang, colony) VALUES (:1, :2, :3, :4, :5, :6, :7)", rows)
    conn.commit()
    return len(rows)


def load_geo(conn) -> dict:
    cur = conn.cursor()
    cur.execute("SELECT iso_o, iso_d, dist, distw, contig, comlang, colony FROM app_pi_geo")
    return {(o, d): {"dist": float(di), "distw": None if dw is None else float(dw), "contig": int(c), "comlang": int(cl), "colony": int(co)} for o, d, di, dw, c, cl, co in cur}


# ---------------------------------------------------------------------------------------------------------------
# Estimator
# ---------------------------------------------------------------------------------------------------------------

def ppml(y: np.ndarray, X: np.ndarray, max_iter: int = 60, tol: float = 1e-9, ridge: float = 1e-8):
    """Poisson pseudo-maximum likelihood by iteratively reweighted least squares. Returns (beta, converged, iterations)."""
    n, p = X.shape
    mu = (y + y.mean()) / 2.0 + 1e-9
    eta = np.log(mu)
    beta = np.zeros(p)
    dev_old = np.inf
    for it in range(1, max_iter + 1):
        z = eta + (y - mu) / mu
        XtW = X.T * mu
        A = XtW @ X + ridge * np.eye(p)
        beta = np.linalg.solve(A, XtW @ z)
        eta = np.clip(X @ beta, -40, 40)
        mu = np.exp(eta)
        with np.errstate(divide="ignore", invalid="ignore"):
            d = 2.0 * np.sum(np.where(y > 0, y * np.log(y / mu), 0.0) - (y - mu))
        if abs(dev_old - d) / (abs(d) + 0.1) < tol:
            return beta, True, it
        dev_old = d
    return beta, False, max_iter


def robust_se(y: np.ndarray, X: np.ndarray, beta: np.ndarray, ridge: float = 1e-8) -> np.ndarray:
    mu = np.exp(np.clip(X @ beta, -40, 40))
    A = (X.T * mu) @ X + ridge * np.eye(X.shape[1])
    Ai = np.linalg.inv(A)
    meat = (X.T * (y - mu) ** 2) @ X
    V = Ai @ meat @ Ai
    return np.sqrt(np.clip(np.diag(V), 0, None))


def _design(imp_idx, exp_idx, n_imp, n_exp, costs):
    """Full-dummy design: all exporter dummies, importer dummies minus the first (the constant is carried by the exporter set)."""
    n = len(imp_idx)
    cols = costs.shape[1]
    X = np.zeros((n, cols + (n_imp - 1) + n_exp))
    X[:, :cols] = costs
    for r in range(n):
        if imp_idx[r] > 0:
            X[r, cols + imp_idx[r] - 1] = 1.0
        X[r, cols + (n_imp - 1) + exp_idx[r]] = 1.0
    return X


def fit_chapter(rows: list, geo: dict, seed: int = SEED) -> dict:
    """rows: [(importer, exporter, value_usd)] covering the full importer x exporter grid for the chapter (zeros included).
    Returns a payload with coefficients, validation and pair-level model vs observed, or {'ok': False, 'reason': ...}."""
    pairs = []
    for m, x, v in rows:
        if m == x:
            continue
        g = geo.get((x, m)) or geo.get((m, x))
        if not g or g["dist"] <= 0:
            continue
        pairs.append((m, x, float(v), g))
    if len(pairs) < MIN_PAIRS:
        return {"ok": False, "reason": f"Only {len(pairs)} pairs with distance data."}
    # drop fixed-effect groups with no positive trade: their effect is minus infinity and the estimator cannot use them
    for _ in range(3):
        pos_m, pos_x = {}, {}
        for m, x, v, _g in pairs:
            pos_m[m] = pos_m.get(m, 0.0) + v
            pos_x[x] = pos_x.get(x, 0.0) + v
        kept = [p for p in pairs if pos_m[p[0]] > 0 and pos_x[p[1]] > 0]
        if len(kept) == len(pairs):
            break
        pairs = kept
    n_pos = sum(1 for p in pairs if p[2] > 0)
    if n_pos < MIN_POSITIVE:
        return {"ok": False, "reason": f"Only {n_pos} positive flows."}
    imps = sorted({p[0] for p in pairs})
    exps = sorted({p[1] for p in pairs})
    ii = {k: i for i, k in enumerate(imps)}
    ei = {k: i for i, k in enumerate(exps)}
    y_all = np.array([p[2] for p in pairs]) / 1e6          # million USD keeps the weights well scaled
    costs = np.array([[np.log(p[3]["dist"]), p[3]["contig"], p[3]["comlang"], p[3]["colony"]] for p in pairs])
    imp_idx = np.array([ii[p[0]] for p in pairs])
    exp_idx = np.array([ei[p[1]] for p in pairs])
    rng = np.random.default_rng(seed)
    n = len(pairs)
    test = rng.random(n) < HOLDOUT

    def fit(mask):
        keep_m = set(imp_idx[mask])
        keep_x = set(exp_idx[mask])
        # FE groups with no positive trade inside this training sample are dropped from it
        Xm = {i: y_all[mask & (imp_idx == i)].sum() for i in keep_m}
        Xx = {j: y_all[mask & (exp_idx == j)].sum() for j in keep_x}
        ok_m = {i for i, s in Xm.items() if s > 0}
        ok_x = {j for j, s in Xx.items() if s > 0}
        sel = mask & np.isin(imp_idx, list(ok_m)) & np.isin(exp_idx, list(ok_x))
        mm = sorted(ok_m)
        xx = sorted(ok_x)
        mi = {k: i for i, k in enumerate(mm)}
        xi = {k: i for i, k in enumerate(xx)}
        X = _design([mi[i] for i in imp_idx[sel]], [xi[j] for j in exp_idx[sel]], len(mm), len(xx), costs[sel])
        beta, conv, iters = ppml(y_all[sel], X)
        return beta, conv, iters, mi, xi, sel, X

    # validation on held-out pairs
    tr = ~test
    beta, conv, iters, mi, xi, sel, X = fit(tr)
    c = costs.shape[1]
    pred_t = np.full(n, np.nan)
    base_t = np.full(n, np.nan)
    M_tot = {i: y_all[tr & (imp_idx == i)].sum() for i in set(imp_idx)}
    X_tot = {j: y_all[tr & (exp_idx == j)].sum() for j in set(exp_idx)}
    T = y_all[tr].sum()
    for r in np.where(test)[0]:
        i, j = imp_idx[r], exp_idx[r]
        if i in mi and j in xi:
            eta = costs[r] @ beta[:c] + (beta[c + mi[i] - 1] if mi[i] > 0 else 0.0) + beta[c + (len(mi) - 1) + xi[j]]
            pred_t[r] = np.exp(np.clip(eta, -40, 40))
            base_t[r] = M_tot.get(i, 0.0) * X_tot.get(j, 0.0) / T if T > 0 else np.nan
    ok = ~np.isnan(pred_t) & test
    metrics = {"heldout_pairs": int(ok.sum()), "converged": bool(conv)}
    if ok.sum() >= 20:
        yt, pt, bt = y_all[ok], pred_t[ok], np.maximum(base_t[ok], 1e-9)
        rm = lambda a, b: float(np.sqrt(np.mean((np.log1p(a * 1000) - np.log1p(b * 1000)) ** 2)))   # log of thousand USD plus one
        rl = lambda a, b: float(np.sqrt(np.mean((a - b) ** 2)))                                      # million USD, in levels

        def dev(a, b):
            with np.errstate(divide="ignore", invalid="ignore"):
                return float(np.mean(2.0 * (np.where(a > 0, a * np.log(a / b), 0.0) - (a - b))))

        better = {"level_rmse": rl(yt, pt) < rl(yt, bt), "poisson_deviance": dev(yt, pt) < dev(yt, bt)}
        metrics.update({"rmse_level_musd_model": rl(yt, pt), "rmse_level_musd_baseline": rl(yt, bt),
                        "deviance_model": dev(yt, pt), "deviance_baseline": dev(yt, bt),
                        "rmse_log_model": rm(yt, pt), "rmse_log_baseline": rm(yt, bt),
                        "corr_log_model": float(np.corrcoef(np.log1p(yt * 1000), np.log1p(pt * 1000))[0, 1]),
                        "corr_log_baseline": float(np.corrcoef(np.log1p(yt * 1000), np.log1p(bt * 1000))[0, 1]),
                        "better_than_baseline_on": [k for k, v in better.items() if v],
                        "model_beats_baseline": bool(all(better.values()))})

    # final fit on every pair
    beta, conv, iters, mi, xi, sel, X = fit(np.ones(n, dtype=bool))
    se = robust_se(y_all[sel], X, beta)
    names = ["ln_distance", "contiguity", "common_language", "colonial_tie"]
    coef = {k: {"coef": round(float(beta[i]), 4), "se": round(float(se[i]), 4)} for i, k in enumerate(names)}
    mu = np.exp(np.clip(X @ beta, -40, 40))
    ss_res = float(np.sum((y_all[sel] - mu) ** 2))
    ss_tot = float(np.sum((y_all[sel] - y_all[sel].mean()) ** 2))
    pred = np.full(n, np.nan)
    pred[sel] = mu
    per_imp = {}
    for r in np.where(sel)[0]:
        obs, pr = y_all[r] * 1e6, pred[r] * 1e6
        if pr >= MIN_PREDICTED_USD:
            per_imp.setdefault(pairs[r][0], []).append({"exporter": pairs[r][1], "observed_usd": round(obs), "model_usd": round(pr),
                                                         "observed_over_model": round(obs / pr, 3), "distance_km": round(pairs[r][3]["dist"])})
    top = {}
    for m, lst in per_imp.items():
        lst.sort(key=lambda d: d["model_usd"] * max(0.0, 1.0 - d["observed_over_model"]), reverse=True)
        top[m] = [d for d in lst if d["observed_over_model"] < 1.0][:TOP_PER_IMPORTER]
    return {"ok": True, "version": GRAVITY_VERSION, "converged": bool(conv), "iterations": iters, "pairs": int(sel.sum()), "positive_flows": int((y_all[sel] > 0).sum()),
            "zero_flows": int((y_all[sel] == 0).sum()), "importers": len(mi), "exporters": len(xi), "coefficients": coef,
            "pseudo_r2": None if ss_tot <= 0 else round(1 - ss_res / ss_tot, 4), "validation": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in metrics.items()},
            "model_vs_observed": top,
            "kind": "estimate", "note": ("Model-expected trade between pairs given their size and trade costs, compared with observed imports. "
                                          "A pair below its expected level is not evidence of unmet demand and this is not a forecast.")}


# ---------------------------------------------------------------------------------------------------------------
# Database side
# ---------------------------------------------------------------------------------------------------------------

def chapter_rows(conn, universe: set, year: int, log=print) -> dict:
    """{chapter: [(importer, exporter, value)]} over the full grid, zeros filled where an importer reported nothing for the pair."""
    cur = conn.cursor()
    cur.arraysize = 50000
    ph = ",".join(f":{i + 2}" for i in range(len(universe)))
    cur.execute(f"""SELECT SUBSTR(cmd_code, 1, 2), reporter_iso3, TRIM(partner_iso3), SUM(value_usd) FROM tf_trade_facts
                     WHERE flow = 'M' AND year = :1 AND partner_iso3 <> 'WLD' AND reporter_iso3 IN ({ph})
                     GROUP BY SUBSTR(cmd_code, 1, 2), reporter_iso3, TRIM(partner_iso3)""", [year, *sorted(universe)])
    data, exporters = {}, set()
    for ch, m, x, v in cur:
        if not markets.is_market(x) or v is None:
            continue
        data.setdefault(ch, {})[(m, x)] = float(v)
        exporters.add(x)
    log(f"{len(data)} chapters, {len(exporters)} exporters")
    out = {}
    for ch, d in data.items():
        out[ch] = [(m, x, d.get((m, x), 0.0)) for m in sorted(universe) for x in sorted(exporters) if m != x]
    return out


def run(conn, universe: set, year: int, write: bool = True, only: Optional[list] = None, log=print) -> dict:
    t0 = time.time()
    geo = load_geo(conn)
    if not geo:
        raise RuntimeError("app_pi_geo is empty: run `product-intel --geo FILE` first")
    chapters = chapter_rows(conn, universe, year, log)
    results, failed = {}, {}
    for ch in sorted(chapters):
        if only and ch not in only:
            continue
        r = fit_chapter(chapters[ch], geo)
        if r.get("ok"):
            results[ch] = r
        else:
            failed[ch] = r.get("reason")
    beat = [c for c, r in results.items() if r["validation"].get("model_beats_baseline")]
    log(f"{len(results)} chapters fitted, {len(failed)} not fitted, model beats baseline in {len(beat)} ({int(time.time() - t0)}s)")
    if write:
        cur = conn.cursor()
        now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
        if not only:
            cur.execute("DELETE FROM app_pi_gravity")
        else:
            cur.executemany("DELETE FROM app_pi_gravity WHERE chapter = :1", [(c,) for c in results])
        cur.setinputsizes(None, None, None, None, __import__("oracledb").DB_TYPE_CLOB)
        cur.executemany("INSERT INTO app_pi_gravity (chapter, year, version, computed_at, payload) VALUES (:1, :2, :3, :4, :5)",
                        [(c, year, GRAVITY_VERSION, now, json.dumps(r, separators=(",", ":"))) for c, r in results.items()])
        meta = {"source": SOURCE_NOTE, "failed": failed, "year": year, "importers": sorted(universe), "computed_at": now,
                "holdout_share": HOLDOUT, "seed": SEED}
        cur.execute("DELETE FROM app_pi_meta WHERE k = 'gravity'")
        cur.execute("INSERT INTO app_pi_meta (k, v, updated_at) VALUES ('gravity', :1, :2)", [json.dumps(meta), now])
        conn.commit()
    return {"fitted": len(results), "failed": failed, "beats_baseline": len(beat), "results": results, "seconds": round(time.time() - t0, 1)}
