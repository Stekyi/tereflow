"""Product growth classifier and forecast, with a held-out-year test.

    python -m tereflow_oracle forecast-eval [--flow X|M|both] [--out reports]
    python -m tereflow_oracle forecast-run  [--flow ...]       (writes app_forecasts)

What it predicts: whether a country's trade in a product (HS6, World total) will grow by at least 10% next
year, and by roughly how much. Features use only the two years before the year being predicted: last
year's growth, the size of the trade, the product's share of the country's total, how many partners trade
it, and how the same product moved across all other countries in the data.

How it is tested: the model is trained on one target year and scored on a LATER year it never saw
(train 2021->2022 features to predict 2023, then test 2022->2023 features to predict 2024). It is compared
with the plain momentum rule the site uses today (last year's growth continues) and with the base rate.
Nothing here goes on the site until the report shows it beats those.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np

MIN_VALUE = 100_000.0        # ignore tiny flows, they are noise
GROW = 0.10                  # "grows" means at least +10%
FEATURES = ["yoy_prev", "log_value", "share", "partners_log", "world_yoy", "country_yoy"]


def load_series(conn, flow: str) -> dict[tuple, dict[int, tuple[float, int]]]:
    """{(reporter, hs6): {year: (value_usd, partner_count)}} for countries with every year in the window."""
    cur = conn.cursor()
    cur.execute("""
        SELECT reporter_iso3, SUBSTR(cmd_code, 1, 6) hs6, year,
               SUM(CASE WHEN partner_iso3 = 'WLD' THEN value_usd END) world_value,
               COUNT(DISTINCT CASE WHEN partner_iso3 <> 'WLD' THEN partner_iso3 END) partners
        FROM tf_trade_facts
        WHERE flow = :1 AND LENGTH(cmd_code) >= 6 AND value_usd IS NOT NULL
        GROUP BY reporter_iso3, SUBSTR(cmd_code, 1, 6), year""", [flow])
    out: dict[tuple, dict[int, tuple[float, int]]] = {}
    for rep, hs6, year, v, p in cur:
        if v is None:
            continue
        out.setdefault((rep, hs6), {})[int(year)] = (float(v), int(p or 0))
    return out


def complete_countries(series, years: list[int], min_rows: int = 500) -> set[str]:
    have: dict[str, set[int]] = {}
    for (rep, _), ys in series.items():
        s = have.setdefault(rep, set())
        s.update(ys)
    return {r for r, s in have.items() if all(y in s for y in years)}


def build(series, countries: set[str], target: int):
    """Feature rows for predicting the growth from target-1 to target. Returns X, y_growth, meta."""
    t1, t2 = target - 1, target - 2
    # World growth of each product across all complete countries, and each country's total growth, from
    # the feature years only (never the target year).
    world: dict[str, list[float]] = {}
    ctot: dict[str, list[float]] = {}
    for (rep, hs6), ys in series.items():
        if rep not in countries or t1 not in ys or t2 not in ys:
            continue
        w = world.setdefault(hs6, [0.0, 0.0])
        w[0] += ys[t2][0]
        w[1] += ys[t1][0]
        c = ctot.setdefault(rep, [0.0, 0.0])
        c[0] += ys[t2][0]
        c[1] += ys[t1][0]
    rows, ys_g, meta = [], [], []
    for (rep, hs6), ys in series.items():
        if rep not in countries or not all(y in ys for y in (t2, t1, target)):
            continue
        v2, v1, v0 = ys[t2][0], ys[t1][0], ys[target][0]
        if v2 < MIN_VALUE or v1 < MIN_VALUE:
            continue
        w, c = world[hs6], ctot[rep]
        rows.append([
            math.log(v1 / v2),
            math.log(v1),
            v1 / c[1],
            math.log1p(ys[t1][1]),
            math.log(w[1] / w[0]) if w[0] > 0 and w[1] > 0 else 0.0,
            math.log(c[1] / c[0]) if c[0] > 0 and c[1] > 0 else 0.0,
        ])
        ys_g.append(v0 / v1 - 1.0)
        meta.append((rep, hs6, v1, v0))
    return np.array(rows), np.array(ys_g), meta


def precision_at(scores, labels, frac=0.1):
    k = max(1, int(len(scores) * frac))
    idx = np.argsort(-scores)[:k]
    return float(labels[idx].mean())


def evaluate(series, flow: str, years=(2021, 2022, 2023, 2024)):
    from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
    from sklearn.metrics import roc_auc_score

    countries = complete_countries(series, list(years))
    train_t, test_t = years[2], years[3]
    Xtr, gtr, _ = build(series, countries, train_t)
    Xte, gte, mte = build(series, countries, test_t)
    if len(Xtr) < 200 or len(Xte) < 200:
        return {"flow": flow, "error": f"too little data (train {len(Xtr)}, test {len(Xte)}, countries {sorted(countries)})"}
    ytr, yte = (gtr >= GROW).astype(int), (gte >= GROW).astype(int)

    clf = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=7)
    clf.fit(Xtr, ytr)
    p = clf.predict_proba(Xte)[:, 1]
    momentum = Xte[:, 0]                       # last year's log growth: the rule the site uses today

    reg = GradientBoostingRegressor(n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8, loss="huber", random_state=7)
    reg.fit(Xtr, np.clip(np.log1p(np.clip(gtr, -0.95, 5)), -3, 2))
    pred = reg.predict(Xte)
    truth = np.log1p(np.clip(gte, -0.95, 5))
    resid = truth - pred
    naive_mae = float(np.mean(np.abs(truth - 0.0)))
    mom_mae = float(np.mean(np.abs(truth - np.clip(momentum, -3, 2))))
    mae = float(np.mean(np.abs(resid)))
    lo, hi = np.quantile(resid, [0.1, 0.9])
    coverage = float(np.mean((truth >= pred + lo) & (truth <= pred + hi)))   # in-sample by construction, informational

    base = float(yte.mean())
    res = {
        "flow": flow, "countries": sorted(countries), "train_target_year": train_t, "test_target_year": test_t,
        "train_rows": int(len(Xtr)), "test_rows": int(len(Xte)), "base_rate_test": round(base, 4),
        "auc_model": round(float(roc_auc_score(yte, p)), 4),
        "auc_momentum": round(float(roc_auc_score(yte, momentum)), 4),
        "precision_top10_model": round(precision_at(p, yte), 4),
        "precision_top10_momentum": round(precision_at(momentum, yte), 4),
        "accuracy_model": round(float(((p >= 0.5).astype(int) == yte).mean()), 4),
        "accuracy_always_majority": round(max(base, 1 - base), 4),
        "mae_log_growth_model": round(mae, 4), "mae_log_growth_momentum": round(mom_mae, 4), "mae_log_growth_zero": round(naive_mae, 4),
        "interval_10_90": [round(float(lo), 3), round(float(hi), 3)],
        "importance": {f: round(float(i), 3) for f, i in zip(FEATURES, clf.feature_importances_)},
    }
    res["beats_momentum"] = bool(res["auc_model"] > res["auc_momentum"] and res["precision_top10_model"] > res["precision_top10_momentum"])
    res["beats_base_rate"] = bool(res["precision_top10_model"] > base)
    return res


def fmt_report(results: list[dict]) -> str:
    L = ["# Tereflow growth model: held-out-year test", "",
         f"Generated {time.strftime('%Y-%m-%d %H:%M')}. Target: a product's World trade value grows at least {int(GROW*100)}% year on year.",
         "The model is trained on one year and scored on a later year it never saw. 'Momentum' is the rule the site uses now.", ""]
    for r in results:
        L.append(f"## {'Exports' if r['flow'] == 'X' else 'Imports'}")
        if "error" in r:
            L += [r["error"], ""]
            continue
        L += [
            f"Countries with complete data: {', '.join(r['countries'])}.",
            f"Trained to predict {r['train_target_year']} ({r['train_rows']:,} product-country rows); tested on {r['test_target_year']} ({r['test_rows']:,} rows). Base rate of growers in the test year: {r['base_rate_test']:.1%}.", "",
            "| Measure | Model | Momentum rule | Naive |", "|---|---|---|---|",
            f"| AUC (ranking growers above non-growers, 0.5 = chance) | {r['auc_model']} | {r['auc_momentum']} | 0.5 |",
            f"| Precision in the top 10% ranked | {r['precision_top10_model']:.1%} | {r['precision_top10_momentum']:.1%} | {r['base_rate_test']:.1%} |",
            f"| Accuracy at 0.5 cut | {r['accuracy_model']:.1%} | | {r['accuracy_always_majority']:.1%} (always guess majority) |",
            f"| Mean abs error of log growth | {r['mae_log_growth_model']} | {r['mae_log_growth_momentum']} | {r['mae_log_growth_zero']} (predict no change) |", "",
            f"Typical 10-90% band around a forecast (log growth): {r['interval_10_90'][0]} to {r['interval_10_90'][1]}.",
            f"What it leans on: {', '.join(f'{k} {v}' for k, v in sorted(r['importance'].items(), key=lambda kv: -kv[1]))}.", "",
            f"**Beats momentum on both AUC and top-decile precision: {'yes' if r['beats_momentum'] else 'NO'}.  Beats the base rate: {'yes' if r['beats_base_rate'] else 'NO'}.**", ""]
    L += ["## Limits", "",
          "- Only four years of data exist for most countries, so this is one train year and one test year. One test year can flatter or punish a model; more years will firm it up as data accrues.",
          "- Trade values move with prices and exchange rates, not only volumes. A product that 'grew' may simply have got dearer.",
          "- Shocks (wars, sanctions, tariffs) are not in the features, so the model will miss them.",
          "- The band is the spread of errors on the test year, not a guarantee.", ""]
    return "\n".join(L)


def cmd_eval(conn, flows: list[str], out_dir: Path, log=print) -> list[dict]:
    results = []
    for f in flows:
        log(f"loading {f} series...")
        s = load_series(conn, f)
        log(f"{f}: {len(s):,} product-country series; evaluating")
        results.append(evaluate(s, f))
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d")
    (out_dir / f"growth-model-eval-{stamp}.md").write_text(fmt_report(results), encoding="utf-8")
    (out_dir / f"growth-model-eval-{stamp}.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    return results


def cmd_run(conn, flows: list[str], log=print) -> int:
    """Train on the latest two target years' worth of history and forecast the year after the last full year."""
    from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
    cur = conn.cursor()
    cur.execute("""BEGIN EXECUTE IMMEDIATE 'CREATE TABLE app_forecasts (
        reporter_iso3 VARCHAR2(3) NOT NULL, flow VARCHAR2(1) NOT NULL, hs6 VARCHAR2(6) NOT NULL, base_year NUMBER NOT NULL,
        base_value_usd NUMBER, p_grow NUMBER, growth_pred NUMBER, growth_low NUMBER, growth_high NUMBER,
        model_note VARCHAR2(200), created_at TIMESTAMP DEFAULT SYSTIMESTAMP,
        CONSTRAINT app_forecasts_pk PRIMARY KEY (reporter_iso3, flow, hs6, base_year))';
        EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;""")
    total = 0
    years = (2021, 2022, 2023, 2024)
    for f in flows:
        s = load_series(conn, f)
        countries = complete_countries(s, list(years))
        Xtr, gtr, _ = build(s, countries, years[3])          # features 2022->2023, outcome 2024
        if len(Xtr) < 200:
            log(f"{f}: not enough data")
            continue
        clf = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=7).fit(Xtr, (gtr >= GROW).astype(int))
        reg = GradientBoostingRegressor(n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8, loss="huber", random_state=7)
        reg.fit(Xtr, np.clip(np.log1p(np.clip(gtr, -0.95, 5)), -3, 2))
        lo, hi = np.quantile(np.clip(np.log1p(np.clip(gtr, -0.95, 5)), -3, 2) - reg.predict(Xtr), [0.1, 0.9])
        # Score next year: features come from 2023->2024, the same shape the model learned.
        Xn, _, meta = _next_features(s, countries, 2024)
        if len(Xn) == 0:
            continue
        pg = clf.predict_proba(Xn)[:, 1]
        pr = reg.predict(Xn)
        cur.execute("DELETE FROM app_forecasts WHERE flow = :1 AND base_year = 2024", [f])
        rows = [[m[0], f, m[1], 2024, m[2], float(pg[i]), float(math.expm1(pr[i])), float(math.expm1(pr[i] + lo)), float(math.expm1(pr[i] + hi)),
                 "gbm v1, trained 2023->2024 history"] for i, m in enumerate(meta)]
        for i in range(0, len(rows), 5000):
            cur.executemany("""INSERT INTO app_forecasts (reporter_iso3, flow, hs6, base_year, base_value_usd, p_grow, growth_pred, growth_low, growth_high, model_note)
                               VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10)""", rows[i:i + 5000])
        conn.commit()
        log(f"{f}: {len(rows):,} forecasts for 2025 written")
        total += len(rows)
    return total


def _next_features(series, countries, base_year: int):
    """Features for forecasting base_year -> base_year+1, using base_year-1 and base_year."""
    t1, t2 = base_year, base_year - 1
    world: dict[str, list[float]] = {}
    ctot: dict[str, list[float]] = {}
    for (rep, hs6), ys in series.items():
        if rep not in countries or t1 not in ys or t2 not in ys:
            continue
        w = world.setdefault(hs6, [0.0, 0.0]); w[0] += ys[t2][0]; w[1] += ys[t1][0]
        c = ctot.setdefault(rep, [0.0, 0.0]); c[0] += ys[t2][0]; c[1] += ys[t1][0]
    rows, meta = [], []
    for (rep, hs6), ys in series.items():
        if rep not in countries or t1 not in ys or t2 not in ys:
            continue
        v2, v1 = ys[t2][0], ys[t1][0]
        if v2 < MIN_VALUE or v1 < MIN_VALUE:
            continue
        w, c = world[hs6], ctot[rep]
        rows.append([math.log(v1 / v2), math.log(v1), v1 / c[1], math.log1p(ys[t1][1]),
                     math.log(w[1] / w[0]) if w[0] > 0 and w[1] > 0 else 0.0, math.log(c[1] / c[0]) if c[0] > 0 and c[1] > 0 else 0.0])
        meta.append((rep, hs6, v1))
    return np.array(rows), None, meta
