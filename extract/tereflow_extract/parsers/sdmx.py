"""
Read an SDMX message (ML or JSON) into trade observations.

SDMX is the format Eurostat, the IMF, the OECD and the ECB publish in, so it
carries a large share of the registry. The clean path is the sdmx1 library,
which understands both SDMX-ML and SDMX-JSON and gives back typed observations
with their dimension key and attributes. But real endpoints are not always
conformant, and sdmx1 refuses a message the moment something is off (for
example a generic data message that references a data structure it was not
handed). So when the library raises, this module drops to a plain lxml walk
over <Obs> and <Series> elements, which recovers facts from messages the strict
reader rejects.

A structure-only message (a data flow or code list, no observations) is a valid
response that simply states no facts. It returns an empty list, not an error.
"""

from __future__ import annotations

import io
import logging

from ..contracts import Extraction, Provenance, SourceType
from ..normalize.numbers import parse_number
from ..normalize.currency import detect_currency
from ..normalize.countries import resolve_country
from ..normalize.commodities import parse_hs
from ..normalize.fields import map_header, detect_flow, parse_year

log = logging.getLogger("tereflow.parsers.sdmx")

EXTRACTOR = "sdmx"

# SDMX dimension and attribute ids vary by agency for the same concept. These
# groups let one canonical name absorb the common spellings before falling back
# to the shared header map.
_REPORTER_IDS = {
    "REPORTER", "REF_AREA", "DECLARANT", "GEO", "REPORTING_COUNTRY",
    "REPORTING_ECONOMY", "COUNTRY", "REP_AREA",
}
_PARTNER_IDS = {
    "PARTNER", "COUNTERPART_AREA", "PARTNER_COUNTRY", "COUNTERPART",
    "PARTNER_ECONOMY",
}
_FLOW_IDS = {"FLOW", "TRADE_FLOW", "STK_FLOW", "FLOW_TYPE", "FLOW_BREAKDOWN"}
_PRODUCT_IDS = {
    "PRODUCT", "COMMODITY", "SITC", "CPA", "PROD_NRG", "BOP_ITEM", "NA_ITEM",
}
_HS_IDS = {"HS", "HS_CODE", "HS6", "CN", "CN8"}
_INDICATOR_IDS = {"INDICATOR", "INDIC", "MEASURE"}
_TIME_IDS = {"TIME_PERIOD", "TIME", "OBS_TIME", "YEAR", "REF_PERIOD"}
_CURRENCY_IDS = {"CURRENCY", "UNIT_MEASURE", "UNIT", "CURRENCY_DENOM"}
_QTY_UNIT_IDS = {"UNIT_MEASURE", "UNIT", "UNIT_MULT"}

# ML namespaces cover both structure-specific and generic 2.1, and 2.0. The
# fallback matches on the local element name to stay namespace agnostic.
_ML_ATTEMPT_ORDER = ("generic", "structurespecific")


def parse_sdmx(data: bytes, url: str) -> list[Extraction]:
    """Read one SDMX message into a flat list of observations."""
    try:
        import sdmx
    except ImportError:
        log.error("sdmx1 is not installed; cannot parse sdmx url=%s", url)
        return _lxml_fallback(data, url, note="sdmx1-missing")

    try:
        msg = sdmx.read_sdmx(io.BytesIO(data))
    except Exception as exc:
        # The strict reader rejected the message. Recover what we can rather
        # than lose the whole file.
        log.info("sdmx1 could not parse url=%s reason=%s", url, exc)
        return _lxml_fallback(data, url, note="lxml-fallback")

    datasets = getattr(msg, "data", None)
    if not datasets:
        # A structure message carries no observations. That is a real, empty
        # answer, not a failure.
        return []

    out: list[Extraction] = []
    row_index = 0
    for table_index, ds in enumerate(datasets):
        observations = getattr(ds, "obs", None) or []
        for obs in observations:
            ext = _obs_to_extraction(obs, url, table_index, row_index)
            if ext is not None:
                out.append(ext)
            row_index += 1
    return out


def _obs_to_extraction(obs, url: str, table_index: int, row_index: int):
    key = {}
    try:
        for k, v in obs.key.values.items():
            key[str(k)] = _kv_value(v)
    except Exception:
        pass
    attrib = {}
    try:
        for k, v in obs.attrib.items():
            attrib[str(k)] = _kv_value(v)
    except Exception:
        pass

    raw_value = getattr(obs, "value", None)
    value = parse_number(raw_value)
    if value is None:
        return None

    combined = dict(key)
    # Attributes fill concepts that are not in the key, for example a currency
    # or unit that applies to the whole series.
    for k, v in attrib.items():
        combined.setdefault(k, v)

    fields = _map_concepts(combined)

    reporter_name = reporter_iso3 = None
    if fields.get("reporter"):
        iso, canon, _ = resolve_country(fields["reporter"])
        reporter_iso3 = iso
        reporter_name = canon or fields["reporter"]

    partner_name = partner_iso3 = None
    if fields.get("partner"):
        iso, canon, _ = resolve_country(fields["partner"])
        partner_iso3 = iso
        partner_name = canon or fields["partner"]

    flow = detect_flow(fields["flow"])[0] if fields.get("flow") else None

    product_name = fields.get("product") or fields.get("indicator")
    hs_code = None
    if fields.get("hs_code"):
        hs_code = parse_hs(fields["hs_code"])[0]
    elif product_name:
        code, _ = parse_hs(product_name)
        if code:
            hs_code = code

    year = None
    period = fields.get("time")
    if period:
        year = parse_year(period)[0]

    currency = None
    value_usd = None
    usd_basis = None
    if fields.get("currency"):
        iso, conf = detect_currency(fields["currency"])
        if iso and conf > 0:
            currency = iso
    if currency == "USD":
        value_usd = value
        usd_basis = "reported"

    locator = _series_key(key)

    prov = Provenance(
        source_url=url,
        source_type=SourceType.SDMX,
        extractor=EXTRACTOR,
        table_index=table_index,
        row_index=row_index,
        locator=locator,
        raw_value=str(raw_value),
        raw_label="OBS_VALUE",
    )

    return Extraction(
        reporter_name=reporter_name,
        reporter_iso3=reporter_iso3,
        partner_name=partner_name,
        partner_iso3=partner_iso3,
        flow=flow,
        hs_code=hs_code,
        product_name=product_name,
        sector=fields.get("sector"),
        value=value,
        currency=currency,
        value_usd=value_usd,
        usd_basis=usd_basis,
        qty_unit=fields.get("qty_unit"),
        year=year,
        period=period,
        provenance=prov,
    )


def _map_concepts(concepts: dict) -> dict:
    """Fold varied SDMX dimension ids onto canonical Extraction field names."""
    out: dict[str, str] = {}
    for cid, cval in concepts.items():
        if cval in (None, ""):
            continue
        cid_up = str(cid).upper()
        sval = str(cval)
        if cid_up in _REPORTER_IDS:
            out.setdefault("reporter", sval)
        elif cid_up in _PARTNER_IDS:
            out.setdefault("partner", sval)
        elif cid_up in _FLOW_IDS:
            out.setdefault("flow", sval)
        elif cid_up in _HS_IDS:
            out.setdefault("hs_code", sval)
        elif cid_up in _PRODUCT_IDS:
            out.setdefault("product", sval)
        elif cid_up in _INDICATOR_IDS:
            out.setdefault("indicator", sval)
        elif cid_up in _TIME_IDS:
            out.setdefault("time", sval)
        elif cid_up in _CURRENCY_IDS:
            out.setdefault("currency", sval)
            if cid_up in _QTY_UNIT_IDS:
                out.setdefault("qty_unit", sval)
        else:
            # Not a known SDMX id. The shared header map may still know it.
            canon = map_header(str(cid))
            if canon in ("reporter", "partner", "flow", "product", "hs_code",
                         "year", "currency", "qty_unit", "sector"):
                key = "time" if canon == "year" else canon
                out.setdefault(key, sval)
    return out


def _series_key(key: dict) -> str:
    """A stable series identifier for provenance, dot joined like SDMX keys."""
    if not key:
        return ""
    return ".".join(f"{k}={v}" for k, v in key.items())


def _kv_value(v):
    inner = getattr(v, "value", v)
    # A code value may itself be a Code object with an id.
    return getattr(inner, "id", inner)


def _lxml_fallback(data: bytes, url: str, note: str) -> list[Extraction]:
    """
    Walk the raw XML for <Obs>/<Series> when the strict reader gives up.

    This handles both generic (values under <ObsDimension>/<ObsValue>) and
    structure-specific (dimensions as attributes on <Obs>) layouts by reading
    whatever attributes and child values are present. It is deliberately loose:
    the goal is to recover facts, not to validate the message.
    """
    try:
        from lxml import etree
    except ImportError:
        log.error("lxml not available for sdmx fallback url=%s", url)
        return []

    try:
        root = etree.fromstring(data)
    except Exception as exc:
        log.warning("sdmx lxml fallback could not parse xml url=%s reason=%s", url, exc)
        return []

    obs_elems = [e for e in root.iter() if _local(e.tag) == "Obs"]
    if not obs_elems:
        # No observations of any recognisable form. Nothing to recover.
        return []

    out: list[Extraction] = []
    for row_index, obs in enumerate(obs_elems):
        ext = _lxml_obs(obs, url, row_index, note)
        if ext is not None:
            out.append(ext)
    return out


def _lxml_obs(obs, url: str, row_index: int, note: str):
    concepts: dict[str, str] = {}
    raw_value = None

    # Series-specific layout: every dimension is an attribute on the element,
    # and one attribute holds the value.
    for name, val in obs.attrib.items():
        ln = _local(name)
        if ln.upper() in ("OBS_VALUE", "VALUE"):
            raw_value = val
        else:
            concepts[ln] = val

    # Structure-specific series often keep dimensions on the parent <Series>.
    parent = obs.getparent()
    if parent is not None and _local(parent.tag) == "Series":
        for name, val in parent.attrib.items():
            concepts.setdefault(_local(name), val)

    # Generic layout: values live in child <Value>, <ObsDimension>, <ObsValue>.
    for child in obs.iter():
        ln = _local(child.tag)
        if ln == "ObsValue":
            raw_value = child.get("value", raw_value)
        elif ln == "ObsDimension":
            concepts.setdefault("TIME_PERIOD", child.get("value"))
        elif ln == "Value":
            cid = child.get("id") or child.get("concept")
            if cid:
                concepts.setdefault(cid, child.get("value"))

    # Generic series key sits on the parent <Series> under <SeriesKey>.
    if parent is not None and _local(parent.tag) == "Series":
        for child in parent.iter():
            if _local(child.tag) == "Value":
                cid = child.get("id") or child.get("concept")
                if cid:
                    concepts.setdefault(cid, child.get("value"))

    value = parse_number(raw_value)
    if value is None:
        return None

    fields = _map_concepts(concepts)

    reporter_name = reporter_iso3 = None
    if fields.get("reporter"):
        iso, canon, _ = resolve_country(fields["reporter"])
        reporter_iso3 = iso
        reporter_name = canon or fields["reporter"]

    partner_name = partner_iso3 = None
    if fields.get("partner"):
        iso, canon, _ = resolve_country(fields["partner"])
        partner_iso3 = iso
        partner_name = canon or fields["partner"]

    flow = detect_flow(fields["flow"])[0] if fields.get("flow") else None
    product_name = fields.get("product") or fields.get("indicator")
    hs_code = None
    if fields.get("hs_code"):
        hs_code = parse_hs(fields["hs_code"])[0]
    elif product_name:
        code, _ = parse_hs(product_name)
        if code:
            hs_code = code

    period = fields.get("time")
    year = parse_year(period)[0] if period else None

    currency = None
    value_usd = None
    usd_basis = None
    if fields.get("currency"):
        iso, conf = detect_currency(fields["currency"])
        if iso and conf > 0:
            currency = iso
    if currency == "USD":
        value_usd = value
        usd_basis = "reported"

    prov = Provenance(
        source_url=url,
        source_type=SourceType.SDMX,
        extractor=EXTRACTOR,
        table_index=0,
        row_index=row_index,
        locator=_series_key(concepts),
        raw_value=str(raw_value),
        raw_label="OBS_VALUE",
    )

    return Extraction(
        reporter_name=reporter_name,
        reporter_iso3=reporter_iso3,
        partner_name=partner_name,
        partner_iso3=partner_iso3,
        flow=flow,
        hs_code=hs_code,
        product_name=product_name,
        sector=fields.get("sector"),
        value=value,
        currency=currency,
        value_usd=value_usd,
        usd_basis=usd_basis,
        qty_unit=fields.get("qty_unit"),
        year=year,
        period=period,
        flags=[f"sdmx:{note}"],
        provenance=prov,
    )


def _local(tag) -> str:
    """Strip the XML namespace from a tag so matching is namespace agnostic."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]
