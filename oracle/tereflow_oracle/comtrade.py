"""UN Comtrade client: availability, HS6 (final) and tariff-line retrieval."""
from __future__ import annotations
import hashlib
import json
import os
import time
from pathlib import Path
from dataclasses import dataclass, field

import requests

from .classify import Availability

BASE = "https://comtradeapi.un.org/data/v1"
# Comtrade returns at most this many rows per request and returns exactly this many when it has cut the
# answer short (observed: asking for 250,000 still gave 100,000). A response of this size is therefore
# never trusted: it is split and asked again until every piece comes back smaller than the cap.
API_CAP = 100_000
PARTNER_GROUP = 20
CMD_BATCH = 20
CHAPTERS = [f"{i:02d}" for i in range(1, 100)]


# Every individual partner Comtrade knows (groups such as "World" and "EU" excluded), with the code it
# reports them under. Includes the not-elsewhere-specified areas, which carry real trade.
PARTNER_ISO3: dict[int, str] = {int(k): v for k, v in json.loads((Path(__file__).parent / "data" / "partner_iso3.json").read_text()).items()}
PARTNERS: list[int] = sorted(PARTNER_ISO3)


class RateLimited(Exception):
    """Global stop: Comtrade is throttling this key/address."""
    def __init__(self, retry_after: int | None):
        super().__init__("UN Comtrade is rate limiting this address")
        self.retry_after = retry_after


class ComtradeError(Exception):
    pass


@dataclass
class Row:
    partner_iso3: str
    cmd_code: str
    cmd_desc: str | None
    value_usd: float | None
    net_weight_kg: float | None
    qty: float | None
    qty_unit: str | None


@dataclass
class FetchResult:
    rows: list[Row] = field(default_factory=list)
    requests_made: int = 0
    truncated: bool = False
    digest: str = ""


class Comtrade:
    def __init__(self, api_key: str | None = None, pace_s: float = 1.2, session=None, sleep=time.sleep):
        self.key = api_key or os.environ.get("COMTRADE_API_KEY", "")
        if not self.key:
            raise RuntimeError("COMTRADE_API_KEY is required")
        self.pace = max(pace_s, 1.2)
        self.http = session or requests.Session()
        self.sleep = sleep
        self.calls = 0
        self.last_call = 0.0

    def _get(self, path: str, params: dict) -> dict:
        wait = self.pace - (time.monotonic() - self.last_call)
        if self.last_call and wait > 0:
            self.sleep(wait)
        last = "unknown"
        for attempt in range(3):
            if attempt:
                self.sleep(1.5 * attempt)
            self.last_call = time.monotonic()
            self.calls += 1
            try:
                r = self.http.get(f"{BASE}/{path}", params=params, timeout=90,
                                  headers={"Ocp-Apim-Subscription-Key": self.key, "accept": "application/json"})
            except requests.RequestException as e:
                last = str(e)
                continue
            if r.status_code == 429:
                ra = r.headers.get("retry-after")
                if attempt < 2:
                    self.sleep(max(float(ra), 1.2) if ra and ra.replace(".", "").isdigit() else 2.0)
                    continue
                raise RateLimited(int(ra) if ra and ra.isdigit() else None)
            if r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                continue
            if not r.ok:
                raise ComtradeError(f"HTTP {r.status_code}: {r.text[:180]}")
            body = r.json()
            if body.get("error"):
                raise ComtradeError(str(body["error"]))
            return body
        raise ComtradeError(last)

    def availability(self, reporter_m49: int, year: int, tariffline: bool) -> Availability | None:
        path = "getDaTariffline/C/A/HS" if tariffline else "getDa/C/A/HS"
        body = self._get(path, {"reportercode": reporter_m49, "period": year})
        data = body.get("data") or []
        if not data:
            return None
        d = data[0]
        n = lambda k: int(d[k]) if d.get(k) not in (None, "", 0) else None
        return Availability(n("lengthCmdCode"), n("totalRecords"), d.get("classificationCode") or None,
                            d.get("datasetChecksum") or None, d.get("lastReleased") or None)

    def fetch_hs6(self, reporter_m49: int, year: int, flow: str, m49_to_iso3: dict) -> FetchResult:
        """HS6 aggregate trade (all customs, transport and second-partner rows summed by Comtrade).

        One request per group of partners, halving any group whose answer reaches the API cap, plus a
        request for the World total of each product. A partial year is never returned as complete."""
        out = FetchResult()
        rows: dict[tuple, Row] = {}
        self._hs6_group(reporter_m49, year, flow, [0], m49_to_iso3, rows, out)
        for i in range(0, len(PARTNERS), PARTNER_GROUP):
            self._hs6_group(reporter_m49, year, flow, PARTNERS[i:i + PARTNER_GROUP], m49_to_iso3, rows, out)
        out.rows = list(rows.values())
        out.digest = _digest(out.rows)
        return out

    def _hs6_group(self, rep, year, flow, partners, m49_to_iso3, rows: dict, out: FetchResult):
        body = self._get("get/C/A/HS", {
            "reporterCode": rep, "period": year, "cmdCode": "AG6", "flowCode": flow,
            "partnerCode": ",".join(str(p) for p in partners), "maxRecords": API_CAP,
            "breakdownMode": "classic", "includeDesc": "true",
            "customsCode": "C00", "motCode": 0, "partner2Code": 0})
        data = body.get("data") or []
        out.requests_made += 1
        if len(data) >= API_CAP:
            if len(partners) > 1:
                mid = (len(partners) + 1) // 2
                self._hs6_group(rep, year, flow, partners[:mid], m49_to_iso3, rows, out)
                self._hs6_group(rep, year, flow, partners[mid:], m49_to_iso3, rows, out)
                return
            out.truncated = True      # a single partner alone fills the cap: cannot be split further
        for r in self._to_result(data, m49_to_iso3, 0, False).rows:
            merge_row(rows, r)

    def fetch_tariffline(self, reporter_m49: int, year: int, flow: str, m49_to_iso3: dict) -> FetchResult:
        out = FetchResult()
        for i in range(0, 99, CMD_BATCH):
            self._tariff_batch(reporter_m49, year, flow, CHAPTERS[i:i + CMD_BATCH], m49_to_iso3, out)
            # Announced but not served (the UK, Ghana, the USA and Kenya all do this): the first batch
            # is empty, so the rest would be too. Stop after one request, not five.
            if i == 0 and not out.rows and not out.truncated:
                break
        out.digest = _digest(out.rows)
        return out

    def _tariff_batch(self, rep, year, flow, chapters, m49_to_iso3, out: FetchResult):
        body = self._get("getTariffline/C/A/HS", {
            "reporterCode": rep, "period": year, "cmdCode": ",".join(chapters), "flowCode": flow,
            "maxRecords": API_CAP, "includeDesc": "true"})
        data = body.get("data") or []
        out.requests_made += 1
        if len(data) >= API_CAP:
            if len(chapters) > 1:
                mid = (len(chapters) + 1) // 2
                self._tariff_batch(rep, year, flow, chapters[:mid], m49_to_iso3, out)
                self._tariff_batch(rep, year, flow, chapters[mid:], m49_to_iso3, out)
                return
            out.truncated = True
        out.rows.extend(self._to_result(data, m49_to_iso3, 0, False).rows)

    @staticmethod
    def _to_result(data: list[dict], m49_to_iso3: dict, reqs: int, truncated: bool) -> FetchResult:
        rows: dict[tuple, Row] = {}
        for r in data:
            if (r.get("customsCode") or "C00") != "C00" or int(r.get("motCode") or 0) != 0 \
               or int(r.get("partner2Code") or 0) != 0 or int(r.get("mosCode") or 0) != 0:
                continue
            code = str(r.get("cmdCode") or "").strip()
            if not code or code.upper() == "TOTAL" or not code.isdigit() or not 6 <= len(code) <= 10:
                continue
            pc = r.get("partnerCode")
            if pc is None:
                continue
            iso = "WLD" if int(pc) == 0 else (r.get("partnerISO") or m49_to_iso3.get(int(pc)) or PARTNER_ISO3.get(int(pc)))
            if not iso:
                continue
            pv = r.get("primaryValue")
            merge_row(rows, Row(iso, code, r.get("cmdDesc"),
                                None if pv is None else float(pv),
                                _f(r.get("netWgt")), _f(r.get("qty")), r.get("qtyUnitAbbr") or None))
        res = FetchResult(list(rows.values()), reqs, truncated)
        res.digest = _digest(res.rows)
        return res


def _f(v):
    return None if v is None else float(v)


def _add(a, b):
    """Sum two optional numbers; unreported plus unreported stays unreported, never zero."""
    if a is None:
        return b
    if b is None:
        return a
    return a + b


def merge_row(rows: dict, r: "Row") -> None:
    """Add a row, summing with an existing one for the same country and product.

    Comtrade reports some countries under more than one partner code (the USA as 840, 841 and 842,
    Switzerland as 756 and 757). They are separate reported areas that share an ISO code, so their
    trade adds up; replacing one with the other would silently drop trade."""
    k = (r.partner_iso3, r.cmd_code)
    old = rows.get(k)
    if old is None:
        rows[k] = r
        return
    old.value_usd = _add(old.value_usd, r.value_usd)
    old.net_weight_kg = _add(old.net_weight_kg, r.net_weight_kg)
    old.qty = _add(old.qty, r.qty)
    old.qty_unit = old.qty_unit or r.qty_unit
    old.cmd_desc = old.cmd_desc or r.cmd_desc


def _digest(rows: list[Row]) -> str:
    h = hashlib.sha256()
    for r in sorted(rows, key=lambda x: (x.partner_iso3, x.cmd_code)):
        h.update(json.dumps([r.partner_iso3, r.cmd_code, r.value_usd, r.net_weight_kg]).encode())
    return h.hexdigest()
