import sys, json, collections
sys.path.insert(0, "oracle")
from tereflow_oracle import config, db
from tereflow_oracle.hmrc import Hmrc
config.load_env()
YEAR, FLOW = 2024, "X"
conn = db.connect()
cur = conn.cursor()
cur.execute("""SELECT classification_level, COUNT(*), SUM(value_usd) FROM tf_trade_facts
               WHERE reporter_iso3='GBR' AND year=:1 AND flow=:2 AND partner_iso3='WLD' GROUP BY classification_level""", [YEAR, FLOW])
print("Oracle GBR WLD rows by level:", cur.fetchall())
cur.execute("""SELECT cmd_code, value_usd FROM tf_trade_facts WHERE reporter_iso3='GBR' AND year=:1 AND flow=:2
               AND partner_iso3='WLD' AND classification_level='HS6'""", [YEAR, FLOW])
com6 = {c: float(v or 0) for c, v in cur}
cur.execute("""SELECT partner_iso3, SUM(value_usd) FROM tf_trade_facts WHERE reporter_iso3='GBR' AND year=:1 AND flow=:2
               AND classification_level='HS6' AND partner_iso3<>'WLD' GROUP BY partner_iso3""", [YEAR, FLOW])
comP = {p: float(v or 0) for p, v in cur}
conn.close()
com_total = sum(com6.values())
print(f"Comtrade HS6 WLD total USD {com_total:,.0f} over {len(com6)} codes")

h = Hmrc()
res = h.fetch(YEAR, FLOW, 1.0)  # GBP, unconverted
print("HMRC requests", res.requests_made, "rows", len(res.rows))
gbp = h.total_local(YEAR, FLOW)
rate = com_total / gbp
print(f"HMRC GBP total {gbp:,.0f}; implied USD/GBP {rate:.4f}")
h6 = collections.defaultdict(float); hP = collections.defaultdict(float); codes8 = set(); nes = 0
for r in res.rows:
    if r.partner_iso3 == "WLD": 
        h6[r.cmd_code[:6]] += r.value_usd; codes8.add(r.cmd_code)
    else:
        hP[r.partner_iso3] += r.value_usd
print("HMRC distinct CN8 codes (WLD rows):", len(codes8), " distinct HS6:", len(h6))
# compare per-HS6 after FX
diffs = []
for c in set(h6) | set(com6):
    a, b = h6.get(c, 0) * rate, com6.get(c, 0)
    diffs.append((abs(a - b), c, a, b))
diffs.sort(reverse=True)
tot = sum(d[0] for d in diffs)
print(f"HS6 codes only in HMRC: {len(set(h6)-set(com6))}, only in Comtrade: {len(set(com6)-set(h6))}")
print(f"Sum abs diff / Comtrade total: {tot/com_total:.1%}")
within = sum(1 for d,c,a,b in diffs if b and abs(a-b)/b <= 0.10)
print(f"HS6 codes within 10%: {within} of {len(com6)}")
print("Top 10 gaps (code, HMRC USD, Comtrade USD):")
for d, c, a, b in diffs[:10]: print(f"  {c} {a:,.0f} {b:,.0f}")
print("Top partners (HMRC USD / Comtrade USD):")
for p, v in sorted(hP.items(), key=lambda x: -x[1])[:8]:
    print(f"  {p} {v*rate:,.0f} / {comP.get(p,0):,.0f}")
