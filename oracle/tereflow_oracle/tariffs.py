"""Tariffs from UNCTAD TRAINS through the WITS REST API (datasource "trn"), loaded offline into tf_tariff.

The service is slow (5 to 40 seconds a call) and times out under load, so it is never called from a user
request. Rates are stored exactly as reported, with the HS revision, tariff type and the number of lines
behind each average. A product the source rejects or returns empty is recorded as unavailable and is never
filled with an estimate."""
from __future__ import annotations
import time
import requests

BASE = "https://wits.worldbank.org/API/V1/SDMX/V21/datasource/trn"
WORLD = "000"
# WITS reports the European Union as one reporter; Belgium, France and the Netherlands have no tariff of their own.
REPORTERS = {"USA": "840", "CHN": "156", "CIV": "384", "ZAF": "710", "EUN": "918", "NGA": "566", "GHA": "288", "TGO": "768", "LBR": "430", "SLE": "694"}
MIN_PACE_S = 2.0
TIMEOUT_S = 150


class WitsError(Exception):
    pass


def url_for(reporter: str, partner: str, hs6: str, year: int) -> str:
    return f"{BASE}/reporter/{reporter}/partner/{partner}/product/{hs6}/year/{year}/datatype/reported?format=JSON"


def parse(body: dict) -> list[dict]:
    """Rows from one SDMX-JSON answer. Empty list when the source holds nothing for the query."""
    sets = body.get("dataSets") or []
    if not sets:
        return []
    obs_attrs = {a["id"]: a["values"] for a in (body.get("structure", {}).get("attributes", {}).get("observation") or [])}
    order = [a["id"] for a in (body.get("structure", {}).get("attributes", {}).get("observation") or [])]
    rows = []
    for series in (sets[0].get("series") or {}).values():
        for _t, vals in (series.get("observations") or {}).items():
            def attr(name):
                if name not in order:
                    return None
                idx = vals[1 + order.index(name)] if len(vals) > 1 + order.index(name) else None
                if idx is None or idx == "":
                    return None
                values = obs_attrs.get(name) or []
                try:
                    v = values[int(idx)]
                except (IndexError, ValueError, TypeError):
                    # The code points at a value the answer does not list: treat it as not reported, not as a crash.
                    return None
                return v.get("id") if isinstance(v, dict) else v
            def num(name):
                v = attr(name)
                try:
                    return None if v in (None, "") else float(v)
                except ValueError:
                    return None
            rate = vals[0]
            total = num("TOTALNOOFLINES")
            na = num("NBR_NA_LINES")
            # Lines with no ad valorem equivalent (specific duties such as euros per tonne) carry no percentage.
            # When every line is like that the 0 the source prints is a placeholder, not a rate.
            all_na = total is not None and total > 0 and na is not None and na >= total
            rows.append({
                "rate_pct": None if (rate is None or all_na) else float(rate),
                "no_ad_valorem": all_na,
                "hs_revision": attr("NOMENCODE"), "tariff_type": attr("TARIFFTYPE") or "MFN",
                "rate_measure": attr("OBS_VALUE_MEASURE"),
                "total_lines": total, "pref_lines": num("NBR_PREF_LINES"), "mfn_lines": num("NBR_MFN_LINES"),
                "na_lines": na,
                "min_rate_pct": None if all_na else num("MIN_RATE"), "max_rate_pct": None if all_na else num("MAX_RATE"),
            })
    return rows


class Wits:
    def __init__(self, session=None, sleep=time.sleep, max_calls: int = 200):
        self.http = session or requests.Session()
        self.sleep = sleep
        self.max_calls = max_calls
        self.calls = 0
        self.last = 0.0

    def fetch(self, reporter: str, hs6: str, year: int, partner: str = WORLD) -> list[dict] | None:
        """Rows, [] when the source has none, or raises WitsError. Never invents a value."""
        if self.calls >= self.max_calls:
            raise WitsError("call budget for this run is used up")
        wait = MIN_PACE_S - (time.monotonic() - self.last)
        if self.last and wait > 0:
            self.sleep(wait)
        self.last = time.monotonic()
        self.calls += 1
        try:
            r = self.http.get(url_for(reporter, partner, hs6, year), timeout=TIMEOUT_S, headers={"accept": "application/json"})
        except requests.RequestException as e:
            raise WitsError(f"request failed: {str(e)[:100]}")
        if r.status_code == 400:
            return []        # "product/reporter/partner not valid": the source holds nothing for this query
        if not r.ok:
            raise WitsError(f"HTTP {r.status_code}")
        try:
            return parse(r.json())
        except ValueError:
            raise WitsError("answer was not JSON")


def load_tariffs(conn, client: Wits, reporter_iso3: str, products: list[str], years: list[int], log=print) -> dict:
    code = REPORTERS.get(reporter_iso3)
    if code is None:
        raise SystemExit(f"{reporter_iso3} has no WITS reporter code mapped")
    cur = conn.cursor()
    stored = unavailable = failed = skipped = 0
    for hs6 in products:
        for year in years:
            cur.execute("SELECT status FROM tf_tariff_state WHERE reporter_code=:r AND cmd_code=:c AND year=:y", {"r": code, "c": hs6, "y": year})
            row = cur.fetchone()
            if row and row[0] in ("OK", "UNAVAILABLE"):
                skipped += 1
                continue
            try:
                rows = client.fetch(code, hs6, year)
            except WitsError as e:
                if "budget" in str(e):
                    log(f"{reporter_iso3}: {e}; stopping, state is saved")
                    return {"stored": stored, "unavailable": unavailable, "failed": failed, "skipped": skipped, "budget_used": True}
                log(f"{reporter_iso3} {hs6} {year}: FAILED {e}")
                failed += 1
                continue
            if not rows:
                cur.execute("""MERGE INTO tf_tariff_state t USING (SELECT :r r, :c c, :y y FROM dual) s
                               ON (t.reporter_code=s.r AND t.cmd_code=s.c AND t.year=s.y)
                               WHEN MATCHED THEN UPDATE SET status='UNAVAILABLE', detail='source returned nothing', checked_at=SYSTIMESTAMP
                               WHEN NOT MATCHED THEN INSERT (reporter_code, cmd_code, year, status, detail) VALUES (s.r, s.c, s.y, 'UNAVAILABLE', 'source returned nothing')""",
                            {"r": code, "c": hs6, "y": year})
                conn.commit()
                unavailable += 1
                log(f"{reporter_iso3} {hs6} {year}: unavailable at the source")
                continue
            for x in rows:
                cur.execute("DELETE FROM tf_tariff WHERE reporter_code=:r AND partner_code=:p AND cmd_code=:c AND year=:y AND tariff_type=:t",
                            {"r": code, "p": WORLD, "c": hs6, "y": year, "t": x["tariff_type"]})
                cur.execute("""INSERT INTO tf_tariff (reporter_iso3, reporter_code, partner_code, cmd_code, year, tariff_type, hs_revision, rate_pct,
                                                     rate_measure, total_lines, pref_lines, mfn_lines, na_lines, no_ad_valorem, min_rate_pct, max_rate_pct, source_url)
                               VALUES (:i,:r,:p,:c,:y,:t,:h,:rate,:m,:tl,:pl,:ml,:nl,:nav,:mn,:mx,:u)""",
                            {"i": reporter_iso3, "r": code, "p": WORLD, "c": hs6, "y": year, "t": x["tariff_type"], "h": x["hs_revision"],
                             "rate": x["rate_pct"], "m": x["rate_measure"], "tl": x["total_lines"], "pl": x["pref_lines"], "ml": x["mfn_lines"],
                             "nl": x["na_lines"], "nav": 1 if x["no_ad_valorem"] else 0,
                             "mn": x["min_rate_pct"], "mx": x["max_rate_pct"], "u": url_for(code, WORLD, hs6, year)})
                stored += 1
            cur.execute("""MERGE INTO tf_tariff_state t USING (SELECT :r r, :c c, :y y FROM dual) s
                           ON (t.reporter_code=s.r AND t.cmd_code=s.c AND t.year=s.y)
                           WHEN MATCHED THEN UPDATE SET status='OK', detail=NULL, checked_at=SYSTIMESTAMP
                           WHEN NOT MATCHED THEN INSERT (reporter_code, cmd_code, year, status) VALUES (s.r, s.c, s.y, 'OK')""",
                        {"r": code, "c": hs6, "y": year})
            conn.commit()
            log(f"{reporter_iso3} {hs6} {year}: stored {len(rows)} row(s)")
    return {"stored": stored, "unavailable": unavailable, "failed": failed, "skipped": skipped, "budget_used": False}
