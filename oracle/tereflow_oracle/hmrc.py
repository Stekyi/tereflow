"""UK HM Revenue & Customs overseas trade statistics (uktradeinfo OData API): CN8 tariff lines.

Free, no key. Documented limits: 40,000 rows a page, 60 requests a minute. Values are in GBP and
are converted to USD with the rate passed in. Flows 2 and 4 are EU and non-EU exports, 1 and 3 are
EU and non-EU imports.
"""
from __future__ import annotations
import json
import re
import time
from pathlib import Path

import requests

from .comtrade import FetchResult, Row

BASE = "https://api.uktradeinfo.com"
FLOW_IDS = {"X": (2, 4), "M": (1, 3)}
DATA = Path(__file__).parent / "data"
ISO2_ISO3: dict[str, str] = json.loads((DATA / "iso2_iso3.json").read_text())
SPECIAL_ISO3 = {"XS": "SRB", "CS": "SRB", "XK": "XKX", "AN": "ANT", "DH": "ARE", "DU": "ARE", "HA": "ARE"}
NES = "_X"
UNSPECIFIED = "99999999"
MIN_INTERVAL = 1.1               # seconds between calls, under the 60 a minute limit


class HmrcError(Exception):
    pass


def partner_iso3(alpha2: str | None) -> str:
    """ISO3 for a HMRC country; areas that are not countries (stores, estimates, confidential) are nes."""
    a = (alpha2 or "").strip().upper()
    return SPECIAL_ISO3.get(a) or ISO2_ISO3.get(a) or NES


def cn8(code: str | None) -> str:
    """Eight digits, or the unspecified code for chapter placeholders such as '01------'."""
    c = (code or "").strip()
    return c if re.fullmatch(r"\d{8}", c) else UNSPECIFIED


class Hmrc:
    iso3 = "GBR"
    key = "NATIONAL:HMRC"
    currency = "GBP"
    fx_bounds = (1.0, 1.7)       # sanity range for the implied GBP to USD rate

    def __init__(self, get=None, sleep=time.sleep, log=print):
        self._get = get or self._http_get
        self._sleep, self.log = sleep, log
        self._last = 0.0
        self._countries: dict[int, str] | None = None
        self._commodities: dict[int, str] | None = None

    def _http_get(self, url: str, params: dict | None = None) -> dict:
        wait = MIN_INTERVAL - (time.monotonic() - self._last)
        if wait > 0:
            self._sleep(wait)
        for attempt in range(4):
            try:
                r = requests.get(url, params=params, timeout=300)
                self._last = time.monotonic()
                if r.status_code == 200:
                    return r.json()
                if r.status_code in (429, 500, 502, 503, 504):
                    self._sleep(5 * (attempt + 1))
                    continue
                raise HmrcError(f"HMRC returned {r.status_code}: {r.text[:200]}")
            except requests.RequestException as e:
                if attempt == 3:
                    raise HmrcError(f"HMRC unreachable: {e}")
                self._sleep(5 * (attempt + 1))
        raise HmrcError("HMRC kept failing after retries")

    def _pages(self, path: str, params: dict) -> list[dict]:
        out: list[dict] = []
        j = self._get(f"{BASE}{path}", params)
        while True:
            out += j.get("value", [])
            nxt = j.get("@odata.nextLink")
            if not nxt:
                return out
            j = self._get(nxt, None)

    def _lookups(self):
        if self._countries is None:
            self._countries = {c["CountryId"]: partner_iso3(c.get("CountryCodeAlpha"))
                               for c in self._pages("/Country", {"$top": "1000"})}
            self._commodities = {c["CommodityId"]: cn8(c.get("Cn8Code"))
                                 for c in self._pages("/Commodity", {"$select": "CommodityId,Cn8Code"})}

    @staticmethod
    def _apply(year: int, flow: str, tail: str) -> str:
        a, b = FLOW_IDS[flow]
        return (f"filter(MonthId ge {year}01 and MonthId le {year}12 and (FlowTypeId eq {a} or FlowTypeId eq {b}))"
                + tail)

    GROUP = "/groupby((CommodityId,CountryId),aggregate(Value with sum as v,NetMass with sum as w))"

    def availability(self, year, flow):
        """Lines the source will serve for the year (after grouping), plus a fingerprint that changes
        when HMRC revises or adds a month."""
        from .national import NationalAvailability
        try:
            n = int(((self._get(f"{BASE}/OTS", {"$apply": self._apply(year, flow, self.GROUP + "/aggregate($count as n)")})
                      .get("value") or [{}])[0]).get("n") or 0)
            if not n:
                return None
            tot = (self._get(f"{BASE}/OTS", {"$apply": self._apply(year, flow, "/aggregate(Value with sum as v, MonthId with max as m)")})
                   .get("value") or [{}])[0]
        except HmrcError:
            return None
        m = int(tot.get("m") or 0)
        return NationalAvailability(8, n, f"{n}:{m}:{round(float(tot.get('v') or 0))}", str(m))

    def total_local(self, year, flow):
        j = self._get(f"{BASE}/OTS", {"$apply": self._apply(year, flow, "/aggregate(Value with sum as v)")})
        return float((j.get("value") or [{}])[0].get("v") or 0)

    def fetch(self, year, flow, usd_per_unit):
        self._lookups()
        rows = self._pages("/OTS", {"$apply": self._apply(year, flow, self.GROUP)})
        expect = self.availability(year, flow)
        if expect is None or len(rows) != expect.records:
            raise HmrcError(f"HMRC {year} {flow}: read {len(rows):,} rows but the source reports "
                            f"{expect.records if expect else 0:,}; refusing to store a partial year")
        merged: dict[tuple[str, str], list[float]] = {}
        for r in rows:
            code = cn8(None) if r["CommodityId"] < 0 else self._commodities.get(r["CommodityId"], UNSPECIFIED)
            ptn = self._countries.get(r["CountryId"], NES)
            acc = merged.setdefault((ptn, code), [0.0, 0.0])
            acc[0] += float(r["v"] or 0)
            acc[1] += float(r["w"] or 0)
        world: dict[str, list[float]] = {}
        out = FetchResult(requests_made=0)
        for (ptn, code), (v, w) in merged.items():
            out.rows.append(Row(ptn, code, None, round(v * usd_per_unit, 2), w or None, None, None))
            acc = world.setdefault(code, [0.0, 0.0])
            acc[0] += v
            acc[1] += w
        for code, (v, w) in world.items():
            out.rows.append(Row("WLD", code, None, round(v * usd_per_unit, 2), w or None, None, None))
        out.digest = f"{expect.checksum}"
        return out
