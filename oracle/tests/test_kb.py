"""Invariants for the by-product knowledge base checks.   python oracle/tests/test_kb.py

Pure: a small stand-in for the official wording and for recorded trade. The point is that confidence is computed
from checks, never asserted, and that a wrong relationship from an earlier list is rejected rather than shown."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tereflow_oracle import kb  # noqa: E402

NAMES = {
    "180100": "Cocoa; beans, whole or broken, raw or roasted",
    "180200": "Cocoa; shells, husks, skins and other cocoa waste",
    "180400": "Cocoa; butter, fat and oil",
    "080131": "Nuts, edible; cashew nuts, fresh or dried, in shell",
    "080132": "Nuts, edible; cashew nuts, fresh or dried, shelled",
    "080211": "Nuts, edible; almonds, fresh or dried, in shell",
    "120799": "Oil seeds and oleaginous fruits; n.e.c. in heading no. 1207, whether or not broken",
    "151590": "Vegetable fats and oils and their fractions; fixed, n.e.c. in heading no. 1515",
    "151110": "Vegetable oils; palm oil and its fractions, crude",
    "151321": "Vegetable oils; palm kernel or babassu oil and their fractions, crude",
    "120710": "Oil seeds; palm nuts and kernels, whether or not broken",
}
TRADE = {"180200": {"usd": 90e6, "year": 2025, "reporters": 4}, "180400": {"usd": 600e6, "year": 2025, "reporters": 5},
         "080132": {"usd": 5e5, "year": 2025, "reporters": 2}}


def one(parent, by, kw=(), rejected=None):
    return dict(parent_code=parent, parent_name="p", byproduct_code=by, byproduct_name="b", kind="residue", process="x",
                applications="y", kw=list(kw), rejected=rejected, note=None)


# wording states the derivation and codes exist: verified, and established by recorded trade
a = kb.assess(one("180100", "180200", ["shells", "husks"]), NAMES, TRADE)
assert (a["confidence"], a["status"], a["codes_checked"], a["derivation_checked"]) == ("verified", "established", 1, 1), a
assert a["trade_usd"] == 90e6 and a["byproduct_official"].startswith("Cocoa; shells")

# real classification but little trade: verified, yet only possible, not established
b = kb.assess(one("080131", "080132", ["shelled"]), NAMES, TRADE)
assert (b["confidence"], b["status"]) == ("verified", "possible"), b

# heavy trade in the code but the wording does not state the derivation: NOT established
big = dict(TRADE, **{"151590": {"usd": 800e6, "year": 2025, "reporters": 10}})
h = kb.assess(one("120799", "151590", []), NAMES, big)
assert (h["confidence"], h["status"]) == ("plausible", "possible"), h
assert h["trade_usd"] == 800e6, "the trade is still shown as context"

# a rejected relationship carries no trade figure that could read as support
big2 = dict(TRADE, **{"080211": {"usd": 13e9, "year": 2025, "reporters": 11}})
rj = kb.assess(one("080131", "080211", ["cashew"], "wrong heading"), NAMES, big2)
assert (rj["status"], rj["trade_usd"], rj["trade_reporters"]) == ("rejected", None, None), rj

# the code exists but the wording does not state the derivation: plausible, never verified
c = kb.assess(one("120799", "151590", []), NAMES, TRADE)
assert (c["confidence"], c["derivation_checked"]) == ("plausible", 0), c
d = kb.assess(one("120799", "151590", ["shea"]), NAMES, TRADE)
assert d["confidence"] == "plausible", "a keyword the wording lacks must not verify the link"

# no code, or a code that is not in the nomenclature: unverified, with no invented trade
e = kb.assess(one("080131", None, ["x"]), NAMES, TRADE)
assert (e["confidence"], e["trade_usd"]) == ("unverified", None), e
f = kb.assess(one("080131", "999999", ["x"]), NAMES, TRADE)
assert f["confidence"] == "unverified", f
g = kb.assess(one("999999", "180200", ["shells"]), NAMES, TRADE)
assert g["confidence"] == "unverified", "an unknown parent code cannot be verified"

# the earlier list's wrong relationships are rejected and never shown as established
r1 = kb.assess(one("080131", "080211", ["cashew"], "Shelled cashew is classified 080132."), NAMES, TRADE)
assert (r1["confidence"], r1["status"]) == ("rejected", "rejected")
r2 = kb.assess(one("151110", "151321", ["palm kernel"], "Palm kernel oil comes from the kernel."), NAMES, TRADE)
assert r2["confidence"] == "rejected"

# 4-digit codes match every code under them
assert kb.names_under("1805", {"180500": "x", "180610": "y"}) == ["x"]
assert kb.names_under("", NAMES) == []

# the real candidate list contains both of the earlier list's known errors, as rejected
rej = {(x["parent_code"], x["byproduct_code"]) for x in kb.C if x["rejected"]}
assert ("080131", "0802") in rej and ("151110", "151321") in rej and ("151110", "230660") in rej, rej
# every relationship says what it is and where the wording comes from
for x in kb.C:
    assert x["parent_code"] and x["byproduct_name"] and x["kind"] in ("processed", "residue", "byproduct", "downstream"), x
assert kb.HS_SOURCE_URL.startswith("https://comtradeapi.un.org/")

# the generated SQL is quoted safely and says nothing it did not check
sql = kb.to_sql([one("180100", "180200", ["shells"])], NAMES, TRADE, today="2026-10-16")
assert sql.startswith("DELETE FROM kb_relationship;")
assert "'verified'" in sql and "'established'" in sql and "2026-10-16" in sql
tricky = dict(one("180100", "180200", ["shells"]), parent_name="Cocoa's beans")
assert "Cocoa''s beans" in kb.to_sql([tricky], NAMES, TRADE, today="2026-10-16")
none_sql = kb.to_sql([one("080131", None, [])], NAMES, TRADE, today="2026-10-16")
assert "NULL" in none_sql and "'unverified'" in none_sql and "No HS code" in none_sql

print("kb: all invariants hold")
