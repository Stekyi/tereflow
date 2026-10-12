"""One-off builder: HMRC supplementary unit per CN8 code, from the UK Trade Tariff (measure type 109).
Resumable; writes oracle/tereflow_oracle/data/uk_supp_units.json as {cn8: unit} ('' when the code has none)."""
import json, sys, time, threading, queue, re
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "oracle"))
from tereflow_oracle import db, config

OUT = Path(__file__).resolve().parents[1] / "oracle" / "tereflow_oracle" / "data" / "uk_supp_units.json"
config.load_env()
cur = db.connect().cursor()
cur.execute("SELECT DISTINCT cmd_code FROM tf_trade_facts WHERE reporter_iso3='GBR' AND year>=2020 AND LENGTH(cmd_code)=8 AND partner_iso3='WLD'")
codes = sorted(r[0] for r in cur)
have = json.loads(OUT.read_text()) if OUT.exists() else {}
todo = [c for c in codes if c not in have]
print(len(codes), "codes,", len(todo), "to fetch", flush=True)
q = queue.Queue()
for c in todo: q.put(c)
lock = threading.Lock(); done = [0]

def unit_of(doc):
    inc = doc.get("included", [])
    de = {i["id"]: i["attributes"] for i in inc if i["type"] == "duty_expression"}
    for m in inc:
        if m["type"] != "measure": continue
        mt = (m["relationships"].get("measure_type") or {}).get("data") or {}
        if mt.get("id") == "109":
            d = (m["relationships"].get("duty_expression") or {}).get("data") or {}
            a = de.get(d.get("id"), {})
            return (a.get("base") or "").strip()
    return ""

def worker():
    s = requests.Session()
    while True:
        try: c = q.get_nowait()
        except queue.Empty: return
        for attempt in range(5):
            r = s.get(f"https://www.trade-tariff.service.gov.uk/api/v2/commodities/{c}00", timeout=60)
            if r.status_code == 200:
                u = unit_of(r.json()); break
            if r.status_code == 404: u = ""; break
            time.sleep(3 * (attempt + 1))
        else:
            continue
        with lock:
            have[c] = u; done[0] += 1
            if done[0] % 500 == 0:
                OUT.write_text(json.dumps(have, sort_keys=True)); print(done[0], flush=True)
        time.sleep(0.15)

ts = [threading.Thread(target=worker) for _ in range(16)]
[t.start() for t in ts]; [t.join() for t in ts]
OUT.write_text(json.dumps(have, sort_keys=True, separators=(",", ":")))
print("done", len(have), "missing", len([c for c in codes if c not in have]))


