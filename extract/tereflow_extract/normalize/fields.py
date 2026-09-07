"""
Reading column headers, in the languages these sources publish in.

The registry covers national statistics offices across every continent, so
headers arrive in English, French, Spanish, Portuguese, German and more. A
mapping that only knows English would silently skip most of the non-English
sources, and skipping is quieter than failing: the pipeline would report
success on a file it understood almost none of.

Every mapping here is an exact or prefix match on a known phrase. There is no
fuzzy matching on headers, because a wrong header mapping mislabels an entire
column rather than one cell, and a column of quantities read as values would
be wrong in a way that looks completely normal.
"""

from __future__ import annotations

import re

# Canonical field names the parsers emit. Anything not on this list is dropped.
CANONICAL = {
    "reporter", "partner", "product", "hs_code", "flow",
    "value", "currency", "year", "qty", "qty_unit", "sector", "scale",
}

# Header phrases to canonical fields. Order within a field does not matter;
# matching is longest-first across the whole table so "partner country" beats
# a bare "country".
HEADERS: dict[str, set[str]] = {
    "reporter": {
        "reporter", "reporting country", "reporter country", "reporter name",
        "declarant", "reporting economy", "country of origin", "origin country",
        "geo", "geography", "reference area", "ref_area", "country",
        "pays declarant", "pays déclarant", "pais declarante", "país declarante",
        "meldeland", "reporterland", "país informante", "paese dichiarante",
    },
    "partner": {
        "partner", "partner country", "partner name", "partner economy",
        "trading partner", "counterpart", "counterpart country",
        "destination", "country of destination", "destination country",
        "source country", "supplier country", "origin",
        "pays partenaire", "partenaire", "pais socio", "país socio",
        "socio comercial", "parceiro", "pais de destino", "país de destino",
        "destino", "partnerland", "handelspartner", "bestimmungsland",
        "paese partner", "destinazione",
    },
    "product": {
        "product", "commodity", "commodity name", "product name",
        "description", "product description", "commodity description",
        "goods", "item", "article", "merchandise", "produit", "marchandise",
        "libelle", "libellé", "designation", "désignation",
        "producto", "mercancia", "mercancía", "descripcion", "descripción",
        "produto", "mercadoria", "descricao", "descrição",
        "ware", "warenbezeichnung", "produkt", "bezeichnung",
        "prodotto", "merce", "descrizione",
    },
    "hs_code": {
        "hs", "hs code", "hscode", "hs6", "hs4", "hs2", "hs_code",
        "commodity code", "product code", "tariff code", "tariff line",
        "cn code", "cn8", "nc8", "sitc", "sitc code", "ncm", "taric",
        "code", "code produit", "code sh", "sh", "nomenclature",
        "codigo", "código", "codigo producto", "código producto",
        "warennummer", "zolltarifnummer", "codice",
    },
    "flow": {
        "flow", "trade flow", "flow code", "direction", "trade direction",
        "trade", "trade type", "type of trade", "flow desc", "flow_desc",
        "flux", "sens", "flujo", "fluxo", "handelsstrom", "richtung",
        "imports/exports", "import/export",
    },
    "value": {
        "value", "trade value", "value usd", "value us$", "amount",
        "trade value (us$)", "fob value", "cif value", "fob", "cif",
        "customs value", "statistical value", "monetary value",
        "valeur", "valeur fob", "valeur caf", "montant",
        "valor", "valor fob", "valor cif", "importe", "monto",
        "wert", "warenwert", "statistischer wert", "betrag",
        "valore", "importo",
    },
    "currency": {
        "currency", "currency code", "unit of value", "value unit",
        "devise", "monnaie", "moneda", "moeda", "wahrung", "währung",
        "valuta",
    },
    "year": {
        "year", "period", "time", "time period", "reference period",
        "date", "annee", "année", "periode", "période",
        "ano", "año", "anio", "periodo", "período",
        "jahr", "zeitraum", "anno",
    },
    "qty": {
        "quantity", "qty", "netweight", "net weight", "net weight (kg)",
        "netwgt", "weight", "gross weight", "volume", "tonnage",
        "quantite", "quantité", "poids", "poids net",
        "cantidad", "peso", "peso neto", "quantidade", "peso liquido",
        "menge", "gewicht", "nettogewicht", "quantita", "quantità",
    },
    "qty_unit": {
        "unit", "quantity unit", "unit of quantity", "qty unit", "uom",
        "measure", "unit of measure", "supplementary unit",
        "unite", "unité", "unidad", "unidade", "einheit", "masseinheit",
        "maßeinheit", "unita", "unità",
    },
    "sector": {
        "sector", "sector name", "industry", "category", "section",
        "chapter", "hs section", "product group", "commodity group",
        "secteur", "categorie", "catégorie", "chapitre",
        "sector economico", "categoria", "capitulo", "capítulo",
        "setor", "sektor", "kapitel", "settore",
    },
    # The magnitude stated per row rather than in the heading. StatCan prints
    # "millions" in a SCALAR_FACTOR column beside a VALUE of 12417.8, meaning
    # 12.4 billion. Reading the value column alone is a million times out, and
    # the mistake is invisible because the number itself looks reasonable.
    "scale": {
        "scalar factor", "scalar_factor", "scale", "scale factor",
        "multiplier", "unit multiplier", "magnitude", "power",
        "facteur scalaire", "factor de escala",
    },
}

# Flattened, longest first, so a specific phrase wins over a generic one.
_LOOKUP: list[tuple[str, str]] = sorted(
    ((phrase, field) for field, phrases in HEADERS.items() for phrase in phrases),
    key=lambda pair: len(pair[0]),
    reverse=True,
)

_CLEAN = re.compile(r"[\s_\-./\\]+")
_PARENS = re.compile(r"\s*\([^)]*\)")


def _norm(header: object) -> str:
    s = str(header or "").strip().lower()
    s = s.replace("\u00a0", " ")
    s = _PARENS.sub(" ", s)          # "Value (US$)" -> "value"
    s = _CLEAN.sub(" ", s).strip()
    s = s.strip(" :*")
    return s


def map_header(header: object) -> str | None:
    """
    Map a printed column header to a canonical field, or None.

    None means unrecognised, and the caller must skip that column rather than
    guessing what it holds. A column read as the wrong field is worse than a
    column ignored: it puts real numbers under the wrong name.
    """
    s = _norm(header)
    if not s:
        return None

    for phrase, field in _LOOKUP:
        if s == phrase:
            return field

    # Prefix and containment, still exact on the phrase itself so a header of
    # "partner country code" resolves through "partner country".
    for phrase, field in _LOOKUP:
        if len(phrase) >= 4 and (s.startswith(phrase) or f" {phrase} " in f" {s} "):
            return field

    return None


FLOW_WORDS: dict[str, set[str]] = {
    "export": {
        "export", "exports", "exported", "x", "outbound", "outflow",
        "dispatches", "dispatch", "shipments out", "sales abroad",
        # Short codes. SDMX endpoints at Eurostat, the IMF and the OECD encode
        # the direction this way rather than spelling it out, and 32 sources
        # in this registry are SDMX.
        "exp", "ex", "e", "2", "expo",
        "exportation", "exportations", "exportacion", "exportación",
        "exportaciones", "exportacao", "exportação", "exportacoes",
        "ausfuhr", "ausfuhren", "esportazioni", "uitvoer",
    },
    "import": {
        "import", "imports", "imported", "m", "inbound", "inflow",
        "arrivals", "arrival", "purchases abroad",
        "imp", "im", "i", "1", "impo",
        "importation", "importations", "importacion", "importación",
        "importaciones", "importacao", "importação", "importacoes",
        "einfuhr", "einfuhren", "importazioni", "invoer",
    },
}

# Codes that are one or two characters, or a bare digit. These only resolve
# where the caller knows the field is a flow, because "M" in a product name or
# a "1" in a code column would otherwise become an import.
_AMBIGUOUS_CODES = {"x", "m", "e", "i", "1", "2", "ex", "im"}

# Single letters are used as flow codes in several systems, but only where a
# column is known to be the flow. Treated separately so a stray "M" in a
# product name never becomes an import.
_SINGLE_LETTER = {"x": "export", "m": "import"}


def detect_flow(text: object, *, allow_single_letter: bool = False) -> tuple[str | None, float]:
    """
    Whether a label means exports or imports.

    Returns (flow, confidence). Confidence is 1.0 for a whole-string match and
    0.8 where the word was found inside a longer label, because a longer label
    can contain both ("exports and imports") and that case is refused below.
    """
    if text is None:
        return None, 0.0
    s = _norm(text)
    if not s:
        return None, 0.0

    if len(s) == 1:
        if allow_single_letter and s in _SINGLE_LETTER:
            return _SINGLE_LETTER[s], 0.8
        return None, 0.0

    for flow, words in FLOW_WORDS.items():
        if s in words:
            # A short code is only trustworthy where the field is known to hold
            # a direction. Elsewhere it is far more likely to be something else
            # that happens to be spelled the same.
            if s in _AMBIGUOUS_CODES and not allow_single_letter:
                return None, 0.0
            return flow, 1.0 if len(s) > 2 else 0.85

    hits = {
        flow
        for flow, words in FLOW_WORDS.items()
        for w in words
        if len(w) > 2 and re.search(rf"\b{re.escape(w)}\b", s)
    }
    if len(hits) == 1:
        return hits.pop(), 0.8
    # Both directions in one label, e.g. a header reading "exports and imports".
    # Which one a value belongs to has to come from somewhere else.
    return None, 0.0


_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\b")
# Fiscal year labels. Kept separate because a fiscal year is not a calendar
# year: India's FY2023 runs April 2022 to March 2023, and the US federal year
# starts in October. Attributing a fiscal figure to the calendar year of the
# same name puts it in the wrong year roughly nine months out of twelve.
_FISCAL_RE = re.compile(
    r"\b(?:FY|F\.Y\.|EF|AF)\s*[-/]?\s*(19\d{2}|20\d{2})\b", re.IGNORECASE
)
_SPLIT_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\s*[-/]\s*(\d{2}|\d{4})\b")
_PERIOD_RE = re.compile(
    r"\b(19\d{2}|20\d{2})[\-/]?(?:Q([1-4])|M(0[1-9]|1[0-2])|(0[1-9]|1[0-2]))\b",
    re.IGNORECASE,
)


def parse_year(text: object) -> tuple[int | None, float]:
    """
    Pull a year out of a header or a cell.

    Returns (year, confidence):

      1.00  a bare four-digit year
      0.80  a year found inside a longer string
      0.50  a fiscal or split year label, where the calendar year it maps to
            depends on a convention this module cannot know
      0.00  nothing, or two different years with no way to choose

    A range like "2019-2020" returns None on purpose. A figure printed under it
    could belong to either end, and picking one would be a guess that looks
    exactly like a fact afterwards.
    """
    if text is None:
        return None, 0.0
    s = str(text).strip()
    if not s:
        return None, 0.0

    if re.fullmatch(r"(19\d{2}|20\d{2})", s):
        return int(s), 1.0

    if re.fullmatch(r"(19\d{2}|20\d{2})\.0", s):  # a year that went through a float
        return int(s[:4]), 1.0

    m = _FISCAL_RE.search(s)
    if m:
        return int(m.group(1)), 0.5

    # "2019/20" and "2019-20" are single reporting years written as a span.
    # The label names one year, so it is usable, but which convention decides
    # the calendar year varies by country.
    m = _SPLIT_YEAR_RE.search(s)
    if m:
        start = int(m.group(1))
        tail = m.group(2)
        end = int(tail) if len(tail) == 4 else int(str(start)[:2] + tail)
        if end - start == 1:
            return start, 0.5

    found = {int(m.group(1)) for m in _YEAR_RE.finditer(s)}
    if len(found) == 1:
        return found.pop(), 0.8
    return None, 0.0


def parse_period(text: object) -> tuple[str | None, int | None]:
    """
    Read a sub-annual period label, keeping it as stated.

    Returns (period, year). The period is preserved rather than collapsed to a
    year, because summing four quarters and calling it an annual figure is only
    correct when all four are present, and that is the caller's problem to know.
    """
    if text is None:
        return None, None
    s = str(text).strip()
    m = _PERIOD_RE.search(s)
    if not m:
        year, conf = parse_year(s)
        return (None, year) if conf > 0 else (None, None)

    year = int(m.group(1))
    if m.group(2):
        return f"{year}-Q{m.group(2)}", year
    month = m.group(3) or m.group(4)
    return f"{year}-{month}", year
