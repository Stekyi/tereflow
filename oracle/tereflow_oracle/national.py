"""National statistics offices: the first choice for product detail, Comtrade the fallback.

Policy (set by the owners): when a country publishes deeper product codes through its own free API,
that source is read first. When it does not, Tereflow uses Comtrade, tariff-line if Comtrade really
serves it and HS6 otherwise. A provider only ever makes a country MORE detailed, never less: if it
is unreachable or returns nothing, the country falls back to Comtrade for that year.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol

from .comtrade import FetchResult


@dataclass(frozen=True)
class NationalAvailability:
    level_length: int            # 8 for CN8 tariff lines
    records: int
    checksum: str                # changes when the source's data for the year changes
    released: str | None = None


class NationalProvider(Protocol):
    iso3: str
    key: str                     # stored as the classification source
    currency: str                # ISO currency the source reports in (USD means no conversion)

    def availability(self, year: int, flow: str) -> NationalAvailability | None: ...
    def fetch(self, year: int, flow: str, usd_per_unit: float) -> FetchResult: ...
    def total_local(self, year: int, flow: str) -> float: ...


def registry() -> dict[str, NationalProvider]:
    from .hmrc import Hmrc
    return {"GBR": Hmrc()}
