"""UN Comtrade client: availability, HS6 (final) and tariff-line retrieval."""
from __future__ import annotations
import hashlib
import json
import os
import time
from dataclasses import dataclass, field

import requests

from .classify import Availability

BASE = "https://comtradeapi.un.org/data/v1"
MAX_RECORDS = 250_000
CMD_BATCH = 20
CHAPTERS = [f"{i:02d}" for i in range(1, 100)]


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
        body = self._get("get/C/A/HS", {
            "reporterCode": reporter_m49, "period": year, "cmdCode": "AG6", "flowCode": flow,
            "maxRecords": MAX_RECORDS, "breakdownMode": "classic", "includeDesc": "true",
            "customsCode": "C00", "motCode": 0, "partner2Code": 0})
        data = body.get("data") or []
        return self._to_result(data, m49_to_iso3, 1, len(data) >= MAX_RECORDS)

    def fetch_tariffline(self, reporter_m49: int, year: int, flow: str, m49_to_iso3: dict) -> FetchResult:
        out = FetchResult()
        for i in range(0, 99, CMD_BATCH):
            self._tariff_batch(reporter_m49, year, flow, CHAPTERS[i:i + CMD_BATCH], m49_to_iso3, out)
        out.digest = _digest(out.rows)
        return out

    def _tariff_batch(self, rep, year, flow, chapters, m49_to_iso3, out: FetchResult):
        body = self._get("getTariffline/C/A/HS", {
            "reporterCode": rep, "period": year, "cmdCode": ",".join(chapters), "flowCode": flow,
            "maxRecords": MAX_RECORDS, "includeDesc": "true"})
        data = body.get("data") or []
        out.requests_made += 1
        if len(data) >= MAX_RECORDS:
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
            iso = "WLD" if int(pc) == 0 else (r.get("partnerISO") or m49_to_iso3.get(int(pc)))
            if not iso:
                continue
            pv = r.get("primaryValue")
            rows[(iso, code)] = Row(iso, code, r.get("cmdDesc"),
                                    None if pv is None else float(pv),
                                    _f(r.get("netWgt")), _f(r.get("qty")), r.get("qtyUnitAbbr") or None)
        res = FetchResult(list(rows.values()), reqs, truncated)
        res.digest = _digest(res.rows)
        return res


def _f(v):
    return None if v is None else float(v)


def _digest(rows: list[Row]) -> str:
    h = hashlib.sha256()
    for r in sorted(rows, key=lambda x: (x.partner_iso3, x.cmd_code)):
        h.update(json.dumps([r.partner_iso3, r.cmd_code, r.value_usd, r.net_weight_kg]).encode())
    return h.hexdigest()
