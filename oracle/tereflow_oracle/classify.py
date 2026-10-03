"""Central classification resolver.

One place decides which product classification level Tereflow uses for a
reporter/year. It only trusts what Comtrade's availability endpoints report:
it never invents a national tariff extension and never assumes one country's
depth applies to another.
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class Availability:
    """One row of Comtrade's published availability for a reporter/year."""
    length_cmd_code: int | None
    total_records: int | None = None
    classification_code: str | None = None
    dataset_checksum: str | None = None
    last_released: str | None = None


@dataclass(frozen=True)
class Selection:
    source: str            # TARIFFLINE or FINAL
    level: str             # HS6, HS8, HS10 ...
    length: int
    reason: str
    availability: Availability


def level_name(length: int) -> str:
    return f"HS{length}"


def resolve(tariffline: Availability | None, final: Availability | None) -> Selection | None:
    """Pick the deepest genuinely reported level.

    tariffline deeper than 6 digits  -> use it (HS8, HS10, ...)
    otherwise, FINAL (HS6) reported  -> HS6
    tariffline reporting exactly 6   -> HS6 via FINAL (same depth, cheaper endpoint)
    nothing reported                 -> None (no data; caller records NO_DATA)
    """
    t_len = tariffline.length_cmd_code if tariffline else None
    if tariffline and t_len and t_len > 6 and (tariffline.total_records or 0) > 0:
        return Selection("TARIFFLINE", level_name(t_len), t_len,
                         f"Comtrade tariff-line data reports {t_len}-digit codes", tariffline)
    f_len = final.length_cmd_code if final else None
    if final and (final.total_records or 0) > 0 and f_len:
        reason = "only HS6 is reported for this reporter/year"
        return Selection("FINAL", "HS6", 6, reason, final)
    if tariffline and t_len == 6 and (tariffline.total_records or 0) > 0:
        return Selection("FINAL", "HS6", 6, "tariff-line dataset is itself HS6", tariffline)
    return None


def demote_to_hs6(sel: Selection, final: Availability | None) -> Selection | None:
    """Used when a deeper dataset was announced but returned no rows."""
    if final and (final.total_records or 0) > 0:
        return Selection("FINAL", "HS6", 6, f"{sel.level} announced but returned no rows; using HS6", final)
    return None

