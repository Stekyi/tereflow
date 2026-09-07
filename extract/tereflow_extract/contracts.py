"""
The shapes everything else agrees on.

Two records leave this pipeline and they are deliberately different.

`Fact` is the narrow one. It matches `IngestFact` in the Worker exactly, so a
file of them can be posted to /api/admin/ingest/facts with no translation and
no schema change. Its `value_usd` is NOT NULL in D1, which means a row can only
become a Fact once its money is known to be in US dollars.

`Extraction` is the wide one. It carries what the source actually said,
including the currency it said it in, the page it came from, how confident the
extractor is, and enough provenance to go back and check. Most of that has
nowhere to live in `trade_facts`, and inventing columns on a table the working
pipeline writes to would be the wrong kind of change.

So the flow is: parse into Extraction, judge it, and narrow the ones that pass
into Fact. The ones that do not pass are written to a quarantine file with the
reason, never silently dropped and never guessed at.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Literal

Flow = Literal["export", "import"]
Stream = Literal["goods", "services"]


class SourceType(str, Enum):
    """
    What a URL actually returned, established by looking at the bytes.

    Not what the registry says it is. The `fmt` column on entity_sources
    records what a source *offers*, which is a different claim: of five URLs
    registered as csv, four return HTML landing pages that link to a CSV
    somewhere, and one returns a directory listing. Trusting the label would
    hand a pandas CSV reader a page of markup and get back rows of angle
    brackets that look like data.
    """

    CSV = "csv"
    EXCEL = "excel"
    JSON = "json"
    SDMX = "sdmx"
    HTML_STATIC = "html_static"
    HTML_DYNAMIC = "html_dynamic"
    PDF_TEXT = "pdf_text"
    PDF_SCANNED = "pdf_scanned"
    ZIP = "zip"
    UNKNOWN = "unknown"


class Verdict(str, Enum):
    """Why a row did or did not make it into the Fact file."""

    ACCEPTED = "accepted"
    LOW_CONFIDENCE = "low_confidence"
    NON_USD = "non_usd"
    """
    A value was read but nothing said what money it is in.

    Kept separate from NON_USD because the two need different work. A figure
    known to be in cedis is waiting for a dated exchange rate. A figure in an
    unknown currency is waiting for somebody to look at the source and say.
    """
    UNKNOWN_CURRENCY = "unknown_currency"
    MISSING_REQUIRED = "missing_required"
    UNPARSEABLE_VALUE = "unparseable_value"
    NO_YEAR = "no_year"
    AMBIGUOUS_COUNTRY = "ambiguous_country"
    IMPLAUSIBLE = "implausible"


@dataclass
class Provenance:
    """
    Where a number came from, in enough detail to go and look.

    `locator` is deliberately free text because what identifies a cell differs
    by format: a CSV has a row number, a PDF has a page and a table index, an
    HTML page has a table index, an API has a JSON path. Forcing one scheme on
    all of them would either lose detail or invent it.
    """

    source_url: str
    source_type: SourceType
    extractor: str
    page: int | None = None
    table_index: int | None = None
    row_index: int | None = None
    locator: str | None = None
    raw_value: str | None = None
    """The column header or label the value sat under, as printed."""
    raw_label: str | None = None
    retrieved_at: str | None = None
    """Set when the file was reached through a link on a landing page."""
    discovered_from: str | None = None


@dataclass
class ConfidenceBreakdown:
    """
    Why the score is what it is.

    Kept as separate components rather than one number so a low score can be
    argued with. A single opaque 0.42 tells a reader nothing about whether the
    problem was the country name, the year, or the money.
    """

    country: float = 0.0
    commodity: float = 0.0
    flow: float = 0.0
    value: float = 0.0
    year: float = 0.0
    structure: float = 0.0
    notes: list[str] = field(default_factory=list)

    def total(self, weights: dict[str, float]) -> float:
        return round(
            self.country * weights["country"]
            + self.commodity * weights["commodity"]
            + self.flow * weights["flow"]
            + self.value * weights["value"]
            + self.year * weights["year"]
            + self.structure * weights["structure"],
            4,
        )


@dataclass
class Extraction:
    """
    One trade observation as the source stated it.

    Every field that could not be established is None. None means not found,
    never zero and never a guess. A reader downstream can tell the difference
    between "this source reported no partner breakdown" and "this source
    reported trade with nobody", and those are not the same fact.
    """

    reporter_name: str | None = None
    reporter_iso3: str | None = None
    partner_name: str | None = None
    partner_iso3: str | None = None
    flow: Flow | None = None
    stream: Stream = "goods"

    hs_code: str | None = None
    product_name: str | None = None
    sector: str | None = None

    value: float | None = None
    """ISO 4217 where it could be established. Never assumed to be USD."""
    currency: str | None = None
    value_usd: float | None = None
    """How value_usd was arrived at. Only ever 'reported' on this path."""
    usd_basis: str | None = None

    qty: float | None = None
    qty_unit: str | None = None

    year: int | None = None
    period: str | None = None

    confidence: float = 0.0
    breakdown: ConfidenceBreakdown = field(default_factory=ConfidenceBreakdown)
    verdict: Verdict | None = None
    flags: list[str] = field(default_factory=list)

    provenance: Provenance | None = None

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        if self.provenance is not None:
            d["provenance"]["source_type"] = self.provenance.source_type.value
        if self.verdict is not None:
            d["verdict"] = self.verdict.value
        return d


@dataclass
class Fact:
    """
    Exactly `IngestFact` in worker/routes/admin.ts, field for field.

    Nothing optional is invented here. If the Worker would store NULL, this
    carries None, and the endpoint binds it as NULL.
    """

    year: int
    flow: Flow
    stream: Stream
    value_usd: float
    source_ref: str
    partner_iso3: str | None = None
    partner_name: str | None = None
    hs_code: str | None = None
    product_name: str | None = None
    sector: str | None = None
    qty: float | None = None
    qty_unit: str | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Probe:
    """What a HEAD or a first read of the bytes established about a URL."""

    url: str
    final_url: str
    status: int
    content_type: str | None
    content_length: int | None
    source_type: SourceType
    """Which signals agreed, so a wrong call can be traced."""
    evidence: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class SourceResult:
    """Everything one URL produced, including the reasons it produced nothing."""

    url: str
    entity_slug: str | None
    probe: Probe | None
    accepted: list[Fact] = field(default_factory=list)
    extractions: list[Extraction] = field(default_factory=list)
    quarantined: list[Extraction] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    error: str | None = None
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.accepted)
