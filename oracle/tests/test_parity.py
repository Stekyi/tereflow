"""Parity: the Python scoring must reproduce the TypeScript analytics byte for byte on the same inputs.
Fixture generated from worker/analytics via esbuild (see tests/fixtures/ts_parity.json)."""
import json
from pathlib import Path

import pytest

from tereflow_oracle import opportunity as op

FIX = json.loads((Path(__file__).parent / "fixtures" / "ts_parity.json").read_text())
CFG = op.CONFIG["GHA"]


def metrics_for(s):
    yrs = sorted(int(y) for y in s["years"])
    latest = yrs[-1]
    ys = [op.YearTotal(y, float(s["years"][str(y)]), s["weight"], s["partners"] if y == latest else {}) for y in yrs]
    ys = [op.YearTotal(y.year, y.value, y.weight, dict(y.partners)) for y in ys]
    return op.compute_metrics("GHA", s["flow"], "HS6", s["code"], s["desc"], ys)


def all_results():
    ms = [metrics_for(s) for s in FIX["scenarios"]]
    ceiling = max(max(m.value for m in ms), 1)
    out = {}
    for m in ms:
        score, bd = op.score_one(m, CFG["scoring"], ceiling)
        sig = op.classify_signal(m)
        conf, reasons = op.confidence_for(m)
        text, ev = op.explain(m, sig)
        lim = list(m.limitations)
        if m.flow == "M":
            lim.append("Domestic production is not in this dataset, so the gap between local supply and demand cannot be established.")
        excl = op.exclusion_for(m.code, CFG["excluded"])
        if not excl and m.value < op.MIN_MARKET_USD:
            excl = (f"The whole national market is {op.usd(m.value)} a year, which is too small "
                    "to support a business however fast it is growing.")
        out[(m.flow, m.code)] = dict(score=score, bd=bd, sig=sig, conf=conf, reasons=reasons, text=text, ev=ev, lim=lim, excl=excl, m=m)
    return out


RESULTS = all_results()


@pytest.mark.parametrize("exp", FIX["expected"], ids=lambda e: f"{e['flow']}{e['code']}")
def test_matches_typescript(exp):
    got = RESULTS[(exp["flow"], exp["code"])]
    assert got["score"] == exp["score"]
    for k, v in exp["breakdown"].items():
        assert got["bd"][k] == pytest.approx(v, abs=1e-12)
    assert got["sig"] == exp["signal"]
    assert got["conf"] == exp["confidence"]
    assert got["reasons"] == exp["reasons"]
    assert got["excl"] == exp["excluded_reason"]
    assert got["text"] == exp["explanation"]
    assert got["ev"] == exp["evidence"]
    assert got["lim"] == exp["limitations"]
    assert got["m"].trend == exp["trend"]
