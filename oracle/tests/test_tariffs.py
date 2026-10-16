"""Invariants for the WITS tariff parser and loader.   python oracle/tests/test_tariffs.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tereflow_oracle.tariffs import parse, Wits, WitsError, url_for  # noqa: E402

# a real answer shape: EU, 151590, 2022
REAL = {
    "dataSets": [{"series": {"0:0:0:0:0": {"observations": {"0": [5.99090909957886, 0, None, 0, 0, 0, 0, 0, 0, 0, 0, 0]}}}}],
    "structure": {"attributes": {"observation": [
        {"id": "NOMENCODE", "values": [{"id": "H6"}]},
        {"id": "EXCLUDEDFROM", "values": []},
        {"id": "TARIFFTYPE", "values": [{"id": "MFN"}]},
        {"id": "SUM_OF_RATES", "values": [{"id": "65.9"}]},
        {"id": "MIN_RATE", "values": [{"id": "0"}]},
        {"id": "MAX_RATE", "values": [{"id": "12.8"}]},
        {"id": "TOTALNOOFLINES", "values": [{"id": "11"}]},
        {"id": "NBR_PREF_LINES", "values": [{"id": "0"}]},
        {"id": "NBR_MFN_LINES", "values": [{"id": "11"}]},
        {"id": "NBR_NA_LINES", "values": [{"id": "0"}]},
        {"id": "OBS_VALUE_MEASURE", "values": [{"id": "SimpleAverage"}]},
    ]}},
}

rows = parse(REAL)
assert len(rows) == 1, rows
r = rows[0]
assert abs(r["rate_pct"] - 5.9909) < 1e-3
assert r["hs_revision"] == "H6" and r["tariff_type"] == "MFN" and r["rate_measure"] == "SimpleAverage"
assert r["total_lines"] == 11 and r["mfn_lines"] == 11 and r["pref_lines"] == 0
assert r["max_rate_pct"] == 12.8

# nothing in the answer is nothing, never zero
assert parse({"dataSets": []}) == []
assert parse({}) == []


class Resp:
    def __init__(self, code, body=None):
        self.status_code, self._b = code, body
        self.ok = 200 <= code < 300

    def json(self):
        if self._b is None:
            raise ValueError("no json")
        return self._b


class Sess:
    def __init__(self, resp):
        self.resp, self.urls = resp, []

    def get(self, url, **_k):
        self.urls.append(url)
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


nosleep = lambda _s: None
# a 400 ("not valid") means the source holds nothing: empty, not an error and not zero
assert Wits(Sess(Resp(400)), sleep=nosleep).fetch("840", "180100", 2024) == []
# a server error or timeout is an error, so it is never stored as a rate
for bad in (Resp(500), Resp(200, None)):
    try:
        Wits(Sess(bad), sleep=nosleep).fetch("840", "180100", 2020)
        raise AssertionError("should have raised")
    except WitsError:
        pass
import requests  # noqa: E402
try:
    Wits(Sess(requests.Timeout("slow")), sleep=nosleep).fetch("840", "180100", 2020)
    raise AssertionError("timeout should raise")
except WitsError:
    pass

# the call budget is a hard stop
c = Wits(Sess(Resp(200, REAL)), sleep=nosleep, max_calls=2)
c.fetch("918", "151590", 2022)
c.fetch("918", "151590", 2021)
try:
    c.fetch("918", "151590", 2020)
    raise AssertionError("budget should stop the third call")
except WitsError as e:
    assert "budget" in str(e)

assert url_for("918", "000", "180100", 2022).endswith("/reporter/918/partner/000/product/180100/year/2022/datatype/reported?format=JSON")
print("tariffs: all invariants hold")
