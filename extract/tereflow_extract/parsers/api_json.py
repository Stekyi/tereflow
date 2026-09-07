"""
Turn an API JSON payload into trade observations.

Statistical APIs almost never hand back a bare array of records. The rows are
buried under a key that varies by agency (data, results, dataset, value,
observations, rows), sometimes several levels down, and sometimes delivered
column-first as parallel arrays that have to be zipped back into records. On
top of that, an error is often returned with a 200 status and a shape that
looks enough like data to fool a naive reader into treating the error string
as a product name.

So this module does not trust any single key. It walks the whole structure,
finds the largest set of records that actually share fields worth reading, and
records the JSON path it took so any row can be traced back.
"""

from __future__ import annotations

import json
import logging

from ..contracts import Extraction, Provenance, SourceType
from ..normalize.numbers import parse_number
from ..normalize.currency import detect_currency
from ..normalize.countries import resolve_country
from ..normalize.commodities import parse_hs
from ..normalize.fields import map_header, detect_flow, parse_year

log = logging.getLogger("tereflow.parsers.api_json")

EXTRACTOR = "api_json"

# A record has to yield at least this many known fields before it is believed
# to be a record at all. Below it, matching keys is more guess than read.
_MIN_RECOGNISED = 2


def parse_json(data: bytes, url: str) -> list[Extraction]:
    """Read one JSON payload into a flat list of observations."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text, _ = _decode_fallback(data)
    try:
        doc = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        log.warning("payload was not valid JSON url=%s", url)
        return []

    candidates = _record_arrays(doc, "$")
    best = _best_candidate(candidates)
    if best is None:
        # No usable records. If the payload is an error envelope, that is the
        # whole story, and the error text must never become a product name.
        if _looks_like_error(doc):
            log.info("json payload was an error envelope url=%s", url)
        return []

    path, records = best
    out: list[Extraction] = []
    for i, rec in enumerate(records):
        ext = _record_to_extraction(rec, url, f"{path}[{i}]", i)
        if ext is not None:
            out.append(ext)
    return out


def _record_arrays(obj, path: str) -> list[tuple[str, list[dict]]]:
    """
    Walk the whole document and collect every plausible array of records.

    Two shapes count as records: a list of dicts that share keys, and the
    column-oriented pairing of a "columns" list with a "rows" list of lists,
    which is expanded into dicts here so the rest of the pipeline sees one
    shape only.
    """
    found: list[tuple[str, list[dict]]] = []

    if isinstance(obj, dict):
        cols = obj.get("columns")
        rows = obj.get("rows")
        if (
            isinstance(cols, list)
            and isinstance(rows, list)
            and cols
            and rows
            and all(isinstance(r, list) for r in rows)
        ):
            names = [str(c) for c in cols]
            expanded = [
                dict(zip(names, r)) for r in rows if isinstance(r, list)
            ]
            if expanded:
                found.append((f"{path}.rows", expanded))
        for key, value in obj.items():
            found.extend(_record_arrays(value, f"{path}.{key}"))
    elif isinstance(obj, list):
        dicts = [x for x in obj if isinstance(x, dict)]
        # A list is a record array only if most of it is dicts. A list of
        # scalars is a code list or a footnote, not observations.
        if dicts and len(dicts) >= max(1, len(obj) // 2):
            found.append((path, dicts))
        for i, value in enumerate(obj):
            found.extend(_record_arrays(value, f"{path}[{i}]"))

    return found


def _best_candidate(
    candidates: list[tuple[str, list[dict]]]
) -> tuple[str, list[dict]] | None:
    """
    Choose the longest array whose records actually carry known fields.

    Length is the primary signal because the real data set is almost always the
    biggest list in the document. Candidates whose keys map to fewer than two
    known fields are dropped so a large list of metadata cannot outrank a
    smaller list of genuine observations.
    """
    scored: list[tuple[int, int, str, list[dict]]] = []
    for path, records in candidates:
        recognised = _recognised_key_count(records)
        if recognised < _MIN_RECOGNISED:
            continue
        scored.append((len(records), recognised, path, records))
    if not scored:
        return None
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    _, _, path, records = scored[0]
    return path, records


def _recognised_key_count(records: list[dict]) -> int:
    """How many distinct known fields appear across a sample of the records."""
    seen: set[str] = set()
    for rec in records[:25]:
        for key in rec.keys():
            canon = map_header(str(key))
            if canon:
                seen.add(canon)
    return len(seen)


def _record_to_extraction(
    rec: dict, url: str, locator: str, row_index: int
) -> Extraction | None:
    fields: dict[str, object] = {}
    raw_keys: dict[str, str] = {}
    for key, value in rec.items():
        canon = map_header(str(key))
        if canon and canon not in fields:
            fields[canon] = value
            raw_keys[canon] = str(key)

    if len([k for k in fields if k]) < _MIN_RECOGNISED:
        # Not enough of this record was understood to trust it as an
        # observation. Skipped, not filled in with guesses.
        return None

    if "value" not in fields:
        return None
    value = parse_number(_as_number(fields["value"]))
    if value is None:
        return None

    reporter_name = reporter_iso3 = None
    if fields.get("reporter") not in (None, ""):
        iso, canon, _ = resolve_country(str(fields["reporter"]))
        reporter_iso3 = iso
        reporter_name = canon or str(fields["reporter"])

    partner_name = partner_iso3 = None
    if fields.get("partner") not in (None, ""):
        iso, canon, _ = resolve_country(str(fields["partner"]))
        partner_iso3 = iso
        partner_name = canon or str(fields["partner"])

    product_name = None
    if fields.get("product") not in (None, ""):
        product_name = str(fields["product"])
    hs_code = None
    if fields.get("hs_code") not in (None, ""):
        hs_code = parse_hs(str(fields["hs_code"]))[0]
    elif product_name:
        code, _ = parse_hs(product_name)
        if code:
            hs_code = code

    flow = None
    if fields.get("flow") not in (None, ""):
        flow = detect_flow(str(fields["flow"]))[0]

    year = None
    if fields.get("year") not in (None, ""):
        year = parse_year(str(fields["year"]))[0]

    qty = None
    if fields.get("qty") not in (None, ""):
        qty = parse_number(_as_number(fields["qty"]))

    currency = None
    value_usd = None
    usd_basis = None
    for cand in (
        fields.get("currency"),
        raw_keys.get("value"),
        fields.get("value"),
    ):
        if cand in (None, ""):
            continue
        iso, conf = detect_currency(str(cand))
        if iso and conf > 0:
            currency = iso
            break
    if currency == "USD":
        value_usd = value
        usd_basis = "reported"

    prov = Provenance(
        source_url=url,
        source_type=SourceType.JSON,
        extractor=EXTRACTOR,
        table_index=0,
        row_index=row_index,
        locator=locator,
        raw_value=str(fields["value"]),
        raw_label=raw_keys.get("value"),
    )

    return Extraction(
        reporter_name=reporter_name,
        reporter_iso3=reporter_iso3,
        partner_name=partner_name,
        partner_iso3=partner_iso3,
        flow=flow,
        hs_code=hs_code,
        product_name=product_name,
        sector=str(fields["sector"]) if fields.get("sector") not in (None, "") else None,
        value=value,
        currency=currency,
        value_usd=value_usd,
        usd_basis=usd_basis,
        qty=qty,
        qty_unit=str(fields["qty_unit"]) if fields.get("qty_unit") not in (None, "") else None,
        year=year,
        provenance=prov,
    )


def _looks_like_error(doc) -> bool:
    if not isinstance(doc, dict):
        return False
    if "error" in doc or "errors" in doc:
        return True
    # A lone message with nothing data-shaped alongside it is an error too.
    if "message" in doc and not any(
        k in doc for k in ("data", "results", "dataset", "value", "observations", "rows")
    ):
        return True
    return False


def _as_number(v):
    if isinstance(v, bool):
        return ""
    if isinstance(v, (int, float)):
        return v
    return str(v) if v is not None else ""


def _decode_fallback(data: bytes) -> tuple[str, str]:
    try:
        import chardet

        guess = chardet.detect(data)
        enc = (guess or {}).get("encoding") or "utf-8"
    except Exception:
        enc = "utf-8"
    return data.decode(enc, errors="replace"), enc
