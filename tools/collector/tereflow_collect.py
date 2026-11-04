"""Tereflow collector: pull UN Comtrade trade data for chosen countries and analyse it, on any PC.

Needs Python 3.9+ and the `requests` package. Your own free Comtrade key goes in COMTRADE_API_KEY
(or --api-key). Nothing here talks to the Tereflow database, so it holds no Tereflow secrets.

Examples:
  python tereflow_collect.py --list-countries
  python tereflow_collect.py --country EST FIN --years 2023 2024
  python tereflow_collect.py --country NOR --years-back 3 --flow X --out D:\\trade
  python tereflow_collect.py --country SWE --years 2024 --dry-run
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
BASE = "https://comtradeapi.un.org/data/v1"
API_CAP = 100_000
PARTNER_GROUP = 20
ISO3_M49: dict[str, int] = json.loads((HERE / "iso3_m49.json").read_text())
PARTNER_ISO3: dict[int, str] = {int(k): v for k, v in json.loads((HERE / "partner_iso3.json").read_text()).items()}
PARTNERS = sorted(PARTNER_ISO3)
FIELDS = ["partner_iso3", "hs_code", "description", "value_usd", "net_weight_kg", "qty", "qty_unit"]


class RateLimited(Exception):
    pass


class Api:
    def __init__(self, key: str, pace_s: float):
        self.key, self.pace, self.last, self.calls = key, max(pace_s, 1.2), 0.0, 0
        self.http = requests.Session()

    def get(self, params: dict) -> list[dict]:
        last = "unknown"
        for attempt in range(3):
            wait = self.pace - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            self.calls += 1
            try:
                r = self.http.get(f"{BASE}/get/C/A/HS", params=params, timeout=90,
                                  headers={"Ocp-Apim-Subscription-Key": self.key, "accept": "application/json"})
            except requests.RequestException as e:
                last = str(e)
                time.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code == 429 or (r.status_code == 403 and "quota" in r.text.lower()):
                if attempt < 2 and r.status_code == 429:
                    time.sleep(3)
                    continue
                raise RateLimited(r.text[:200])
            if r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                time.sleep(1.5 * (attempt + 1))
                continue
            if not r.ok:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:180]}")
            return r.json().get("data") or []
        raise RuntimeError(last)


def num(v):
    return None if v in (None, "") else float(v)


def fetch(api: Api, rep: int, year: int, flow: str) -> tuple[dict, bool]:
    """HS6 trade by partner. A group of partners that fills the API cap is halved until it fits."""
    rows: dict[tuple, dict] = {}
    truncated = [False]

    def group(partners):
        data = api.get({"reporterCode": rep, "period": year, "cmdCode": "AG6", "flowCode": flow,
                        "partnerCode": ",".join(map(str, partners)), "maxRecords": API_CAP,
                        "breakdownMode": "classic", "includeDesc": "true",
                        "customsCode": "C00", "motCode": 0, "partner2Code": 0})
        if len(data) >= API_CAP:
            if len(partners) > 1:
                mid = (len(partners) + 1) // 2
                group(partners[:mid])
                group(partners[mid:])
                return
            truncated[0] = True
        for r in data:
            code = str(r.get("cmdCode") or "").strip()
            pc = r.get("partnerCode")
            if not code.isdigit() or len(code) < 6 or pc is None:
                continue
            if (r.get("customsCode") or "C00") != "C00" or int(r.get("motCode") or 0) != 0 or int(r.get("partner2Code") or 0) != 0:
                continue
            iso = "WLD" if int(pc) == 0 else (r.get("partnerISO") or PARTNER_ISO3.get(int(pc)))
            iso = iso.strip() if isinstance(iso, str) else iso
            if not iso:
                continue
            v, w, q = num(r.get("primaryValue")), num(r.get("netWgt")), num(r.get("qty"))
            old = rows.get((iso, code))
            if old is None:
                rows[(iso, code)] = {"partner_iso3": iso, "hs_code": code, "description": r.get("cmdDesc"),
                                     "value_usd": v, "net_weight_kg": w, "qty": q, "qty_unit": r.get("qtyUnitAbbr") or None}
            else:
                for k, x in (("value_usd", v), ("net_weight_kg", w), ("qty", q)):
                    if x is not None:
                        old[k] = (old[k] or 0) + x

    group([0])
    for i in range(0, len(PARTNERS), PARTNER_GROUP):
        group(PARTNERS[i:i + PARTNER_GROUP])
    return rows, truncated[0]


def analyse(out: Path, iso: str, flow: str, years: list[int]) -> None:
    """Per country and flow: yearly totals with growth, top products and partners, and a concentration index."""
    totals, prod, part = {}, {}, {}
    for y in years:
        f = out / "data" / f"{iso}_{y}_{flow}.csv"
        if not f.exists():
            continue
        with f.open(newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if r["partner_iso3"] == "WLD" or not r["value_usd"]:
                    continue
                v = float(r["value_usd"])
                totals[y] = totals.get(y, 0) + v
                if len(r["hs_code"]) == 6:
                    prod.setdefault(y, {})
                    part.setdefault(y, {})
                    prod[y][r["hs_code"]] = prod[y].get(r["hs_code"], 0) + v
                    part[y][r["partner_iso3"]] = part[y].get(r["partner_iso3"], 0) + v
    if not totals:
        return
    (out / "analysis").mkdir(parents=True, exist_ok=True)
    with (out / "analysis" / f"{iso}_{flow}_summary.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["year", "total_usd", "growth_pct", "partner_hhi", "top_partner", "top_partner_share_pct", "top_product", "top_product_share_pct"])
        prev = None
        for y in sorted(totals):
            t = totals[y]
            pp = sorted(part.get(y, {}).items(), key=lambda kv: -kv[1])
            pr = sorted(prod.get(y, {}).items(), key=lambda kv: -kv[1])
            ptot = sum(v for _, v in pp) or 1
            hhi = sum((v / ptot * 100) ** 2 for _, v in pp)
            w.writerow([y, round(t), "" if not prev else round((t / prev - 1) * 100, 1), round(hhi),
                        pp[0][0] if pp else "", round(pp[0][1] / ptot * 100, 1) if pp else "",
                        pr[0][0] if pr else "", round(pr[0][1] / (sum(v for _, v in pr) or 1) * 100, 1) if pr else ""])
            prev = t
    last = max(totals)
    with (out / "analysis" / f"{iso}_{flow}_top_{last}.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["kind", "code", "value_usd", "share_pct"])
        for kind, d in (("product", prod.get(last, {})), ("partner", part.get(last, {}))):
            tot = sum(d.values()) or 1
            for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:25]:
                w.writerow([kind, k, round(v), round(v / tot * 100, 2)])


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Collect and analyse UN Comtrade trade data.")
    p.add_argument("--country", nargs="*", default=[], metavar="ISO3", help="reporter countries, e.g. EST FIN SWE")
    p.add_argument("--years", nargs="*", type=int, help="explicit years, e.g. 2022 2023 2024")
    p.add_argument("--years-back", type=int, default=3, help="when --years is not given, this many closed years (default 3)")
    p.add_argument("--flow", choices=["X", "M", "both"], default="both", help="X exports, M imports (default both)")
    p.add_argument("--out", default="tereflow-data", help="output folder (default ./tereflow-data)")
    p.add_argument("--api-key", default=os.environ.get("COMTRADE_API_KEY", ""), help="Comtrade key (or set COMTRADE_API_KEY)")
    p.add_argument("--pace-ms", type=int, default=1200, help="ms between calls, minimum 1200")
    p.add_argument("--force", action="store_true", help="refetch files that already exist")
    p.add_argument("--no-analysis", action="store_true", help="collect only, skip the analysis files")
    p.add_argument("--analyse-only", action="store_true", help="analyse existing files, no downloads")
    p.add_argument("--dry-run", action="store_true", help="show what would be fetched and stop")
    p.add_argument("--list-countries", action="store_true", help="print the supported ISO3 codes and exit")
    a = p.parse_args(argv)

    if a.list_countries:
        print(" ".join(sorted(ISO3_M49)))
        return 0
    countries = [c.upper() for c in a.country]
    if not countries:
        p.error("give at least one --country (see --list-countries)")
    bad = [c for c in countries if c not in ISO3_M49]
    if bad:
        p.error(f"unknown country code(s): {' '.join(bad)}")
    this_year = dt.date.today().year
    years = sorted(set(a.years)) if a.years else [this_year - i for i in range(1, a.years_back + 1)][::-1]
    flows = ["X", "M"] if a.flow == "both" else [a.flow]
    out = Path(a.out)
    jobs = [(c, y, f) for c in countries for y in years for f in flows]
    if a.dry_run:
        for c, y, f in jobs:
            done = (out / "data" / f"{c}_{y}_{f}.csv").exists() and not a.force
            print(f"{c} {y} {f}: {'have it, skip' if done else 'would fetch'}")
        return 0
    api = None
    status = 0
    for c, y, f in jobs:
        target = out / "data" / f"{c}_{y}_{f}.csv"
        if a.analyse_only or (target.exists() and not a.force):
            continue
        if api is None:
            if not a.api_key:
                sys.exit("No Comtrade key. Set COMTRADE_API_KEY or pass --api-key (free at comtradedeveloper.un.org).")
            api = Api(a.api_key, a.pace_ms / 1000)
        try:
            rows, trunc = fetch(api, ISO3_M49[c], y, f)
        except RateLimited as e:
            print(f"Stopped: Comtrade quota or rate limit reached ({e}). Run again later; finished files are kept.")
            status = 2
            break
        except Exception as e:  # keep going, report at the end
            print(f"{c} {y} {f}: failed ({e})")
            status = 1
            continue
        if not rows:
            print(f"{c} {y} {f}: no data published")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        with tmp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            w.writerows(rows.values())
        if trunc:
            print(f"{c} {y} {f}: WARNING a single partner hit the API cap, file is incomplete")
            tmp.rename(target.with_suffix(".partial.csv"))
            status = status or 1
            continue
        tmp.replace(target)
        print(f"{c} {y} {f}: {len(rows):,} rows")
    if not a.no_analysis:
        for c in countries:
            for f in flows:
                analyse(out, c, f, years)
        print(f"Analysis written to {out / 'analysis'}")
    return status


if __name__ == "__main__":
    sys.exit(main())
