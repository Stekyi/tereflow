"""
One URL in, judged facts out.

This is the router. It fetches, works out what the thing actually is, hands the
bytes to whichever parser knows that format, scores what comes back, and splits
it into what can be stored and what has to be held.

The interesting part is the recovery path. Most sources in this registry are
not the file they claim to be: a URL registered as csv usually returns an HTML
page that links to a CSV somewhere. Rather than recording that as a failure,
landing on HTML where data was expected triggers a search of the page for the
real file and one hop to follow it. That single step is the difference between
most of the registry being unreadable and most of it being readable.

The hop is limited to one on purpose. Two hops starts crawling, and a crawler
pointed at a government site without anybody watching is how a project gets its
IP blocked.
"""

from __future__ import annotations

import logging
import time
from dataclasses import replace
from pathlib import Path

from .confidence import score
from .contracts import Extraction, Probe, SourceResult, SourceType
from .detect import refine_pdf, refine_zip
from .emit import partition
from .fetch import Fetcher

log = logging.getLogger(__name__)

# Types that hold data directly, as opposed to pages that point at it.
#
# ZIP belongs here even though it is a container, because _extract opens it and
# routes on what is inside. Leaving it out meant a discovered archive was
# refused as unreadable at the exact moment discovery had done its job: the
# StatCan table publishes as a zipped CSV, so the one link worth following was
# the one being thrown away.
DATA_TYPES = {
    SourceType.CSV,
    SourceType.EXCEL,
    SourceType.JSON,
    SourceType.SDMX,
    SourceType.PDF_TEXT,
    SourceType.PDF_SCANNED,
    SourceType.ZIP,
}


def _load_parsers():
    """
    Import parsers late and one at a time.

    Each parser pulls in heavy dependencies, and a missing optional one should
    disable that format rather than stop the run. A machine without pdfplumber
    should still process spreadsheets, and should say clearly that it skipped
    the PDFs rather than reporting them as empty.
    """
    available: dict[str, object] = {}
    problems: list[str] = []

    try:
        from .parsers.tabular import parse_tabular
        available["tabular"] = parse_tabular
    except Exception as e:  # noqa: BLE001
        problems.append(f"tabular unavailable: {e}")

    try:
        from .parsers.api_json import parse_json
        available["json"] = parse_json
    except Exception as e:  # noqa: BLE001
        problems.append(f"json unavailable: {e}")

    try:
        from .parsers.sdmx import parse_sdmx
        available["sdmx"] = parse_sdmx
    except Exception as e:  # noqa: BLE001
        problems.append(f"sdmx unavailable: {e}")

    try:
        from .parsers.html_static import parse_html_tables
        available["html"] = parse_html_tables
    except Exception as e:  # noqa: BLE001
        problems.append(f"html unavailable: {e}")

    try:
        from .parsers.discovery import find_data_links
        available["discovery"] = find_data_links
    except Exception as e:  # noqa: BLE001
        problems.append(f"discovery unavailable: {e}")

    try:
        from .parsers.pdf_tables import parse_pdf_tables
        from .parsers.pdf_text import parse_pdf_text, page_text_lengths
        available["pdf_tables"] = parse_pdf_tables
        available["pdf_text"] = parse_pdf_text
        available["pdf_pages"] = page_text_lengths
    except Exception as e:  # noqa: BLE001
        problems.append(f"pdf unavailable: {e}")

    try:
        from .parsers.pdf_ocr import parse_pdf_scanned, ocr_available
        available["pdf_ocr"] = parse_pdf_scanned
        available["ocr_available"] = ocr_available
    except Exception as e:  # noqa: BLE001
        problems.append(f"ocr unavailable: {e}")

    return available, problems


class Pipeline:
    def __init__(
        self,
        fetcher: Fetcher,
        *,
        follow_links: bool = True,
        max_discovered: int = 2,
    ) -> None:
        self.fetcher = fetcher
        self.follow_links = follow_links
        self.max_discovered = max_discovered
        self.parsers, self.parser_problems = _load_parsers()
        for p in self.parser_problems:
            log.warning(p)

    def run_url(
        self,
        url: str,
        *,
        entity_slug: str | None = None,
        declared_fmt: str | None = None,
        source_ref: str | None = None,
        reporter_iso3: str | None = None,
        reporter_name: str | None = None,
        default_flow: str | None = None,
    ) -> SourceResult:
        """
        Process one source.

        `reporter_iso3` and `default_flow` carry what the registry already knows
        about a source and the file itself may not repeat. A national statistics
        office publishing its own export table does not print its own name in
        every row, and the category the source was registered under says which
        direction the file is about. Both are recorded as coming from the
        registry rather than the document, so nothing pretends the file said it.
        """
        started = time.monotonic()
        ref = source_ref or url
        result = SourceResult(url=url, entity_slug=entity_slug, probe=None)

        probe = self.fetcher.probe(url, declared_fmt=declared_fmt)
        result.probe = probe

        if probe.error:
            result.error = probe.error
            result.duration_ms = int((time.monotonic() - started) * 1000)
            return result

        if probe.status >= 400:
            result.error = f"HTTP {probe.status}"
            if probe.status in (401, 403):
                result.notes.append(
                    "The server refused the request. Sites that block scripted "
                    "access usually need the rendered-browser path."
                )
            result.duration_ms = int((time.monotonic() - started) * 1000)
            return result

        extractions = self._extract(url, probe, result)

        # Nothing found on a page that was supposed to hold data. Look for the
        # file it points at, which is the normal shape of these sources.
        if (
            not extractions
            and self.follow_links
            and probe.source_type in (SourceType.HTML_STATIC, SourceType.HTML_DYNAMIC)
            and "discovery" in self.parsers
        ):
            extractions = self._follow(url, probe, result, declared_fmt)

        for ex in extractions:
            if reporter_iso3 and not ex.reporter_iso3:
                ex.reporter_iso3 = reporter_iso3
                ex.reporter_name = ex.reporter_name or reporter_name
                ex.flags.append("reporter:from-registry")
            if default_flow and not ex.flow and default_flow in ("export", "import"):
                ex.flow = default_flow  # type: ignore[assignment]
                ex.flags.append("flow:from-registry-category")
            score(ex)

        accepted, held = partition(extractions, ref)
        result.extractions = extractions
        result.accepted = accepted
        result.quarantined = held
        result.duration_ms = int((time.monotonic() - started) * 1000)
        return result

    def _extract(self, url: str, probe: Probe, result: SourceResult) -> list[Extraction]:
        """Fetch the body and hand it to whichever parser fits."""
        kind = probe.source_type

        if kind is SourceType.UNKNOWN:
            result.notes.append(
                f"Could not establish a format. Signals: {', '.join(probe.evidence)}"
            )
            return []

        fetched = self.fetcher.get(url)
        if fetched.error:
            result.error = fetched.error
            return []
        if not fetched.body:
            result.notes.append("The response had no body.")
            return []
        if fetched.truncated:
            result.notes.append(
                "The file was larger than the size limit and was cut off, so this "
                "extraction is partial rather than complete."
            )

        data = fetched.body

        if kind is SourceType.ZIP:
            kind, data = self._resolve_zip(data, result)
            if kind is SourceType.UNKNOWN or not data:
                return []

        if kind in (SourceType.PDF_TEXT, SourceType.PDF_SCANNED):
            kind = self._resolve_pdf(data, kind, result)

        return self._dispatch(kind, data, url, result)

    def _dispatch(
        self, kind: SourceType, data: bytes, url: str, result: SourceResult
    ) -> list[Extraction]:
        try:
            if kind in (SourceType.CSV, SourceType.EXCEL):
                fn = self.parsers.get("tabular")
                if not fn:
                    result.notes.append("No tabular parser available on this machine.")
                    return []
                return fn(data, kind, url)

            if kind is SourceType.JSON:
                fn = self.parsers.get("json")
                if not fn:
                    result.notes.append("No JSON parser available on this machine.")
                    return []
                return fn(data, url)

            if kind is SourceType.SDMX:
                fn = self.parsers.get("sdmx")
                if not fn:
                    result.notes.append("No SDMX parser available on this machine.")
                    return []
                return fn(data, url)

            if kind in (SourceType.HTML_STATIC, SourceType.HTML_DYNAMIC):
                fn = self.parsers.get("html")
                if not fn:
                    result.notes.append("No HTML parser available on this machine.")
                    return []
                return fn(data, url)

            if kind is SourceType.PDF_TEXT:
                rows: list[Extraction] = []
                tables = self.parsers.get("pdf_tables")
                if tables:
                    rows.extend(tables(data, url))
                # Prose is only read when no table was found. A document with
                # tables says the same figures twice, and reading both would
                # double every number in it.
                if not rows:
                    text = self.parsers.get("pdf_text")
                    if text:
                        rows.extend(text(data, url))
                return rows

            if kind is SourceType.PDF_SCANNED:
                ocr = self.parsers.get("pdf_ocr")
                check = self.parsers.get("ocr_available")
                if check:
                    ok, why = check()
                    if not ok:
                        result.notes.append(
                            f"This PDF is a scan and OCR is not set up: {why}. "
                            "No text was read, which is not the same as the "
                            "document being empty."
                        )
                        return []
                if not ocr:
                    result.notes.append("No OCR parser available on this machine.")
                    return []
                return ocr(data, url)

        except Exception as e:  # noqa: BLE001
            result.error = f"{kind.value} parser failed: {type(e).__name__}: {e}"[:300]
            log.exception("parser failed for %s", url)
            return []

        result.notes.append(f"Nothing handles {kind.value}.")
        return []

    def _resolve_zip(
        self, data: bytes, result: SourceResult
    ) -> tuple[SourceType, bytes]:
        """
        Open an archive and return the bytes of the file worth reading.

        Returning the type alone was not enough: the caller then handed the
        archive itself to a CSV parser, which cannot read one. The largest
        member of the wanted kind is chosen, because bulk statistical zips
        routinely ship the dataset alongside a small readme or a metadata file
        and the dataset is the big one.
        """
        import io
        import zipfile

        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
                inner = refine_zip(names)
                if inner is SourceType.UNKNOWN:
                    result.notes.append(
                        "Archive holds nothing recognised. Contents: "
                        + ", ".join(names[:8])
                    )
                    return SourceType.UNKNOWN, b""

                if inner is SourceType.EXCEL and any(
                    n.startswith("xl/") for n in (x.lower() for x in names)
                ):
                    # An xlsx is itself a zip, so the archive IS the spreadsheet
                    # rather than a container holding one.
                    result.notes.append("Archive is an xlsx workbook.")
                    return SourceType.EXCEL, data

                wanted = {
                    SourceType.CSV: (".csv", ".tsv", ".txt"),
                    SourceType.EXCEL: (".xlsx", ".xls", ".xlsm", ".ods"),
                    SourceType.PDF_TEXT: (".pdf",),
                }.get(inner, ())

                members = [
                    i
                    for i in z.infolist()
                    if not i.is_dir() and i.filename.lower().endswith(wanted)
                ]
                if not members:
                    result.notes.append(
                        f"Archive said it held {inner.value} but no member matched."
                    )
                    return SourceType.UNKNOWN, b""

                pick = max(members, key=lambda i: i.file_size)
                if len(members) > 1:
                    result.notes.append(
                        f"Archive holds {len(members)} files; read the largest, "
                        f"{pick.filename}."
                    )
                else:
                    result.notes.append(f"Archive contains {pick.filename}.")
                return inner, z.read(pick)

        except Exception as e:  # noqa: BLE001
            result.notes.append(f"Could not open the archive: {e}")
            return SourceType.UNKNOWN, b""

    def _resolve_pdf(
        self, data: bytes, kind: SourceType, result: SourceResult
    ) -> SourceType:
        """Text PDF or scan, decided by how much text the pages actually hold."""
        pages_fn = self.parsers.get("pdf_pages")
        if not pages_fn:
            return kind
        try:
            lengths, count = pages_fn(data)
        except Exception as e:  # noqa: BLE001
            result.notes.append(f"Could not read the PDF structure: {e}")
            return kind
        refined = refine_pdf(lengths, count)
        if refined is SourceType.PDF_SCANNED:
            result.notes.append(
                f"{count} pages carrying little or no text layer, treated as a scan."
            )
        return refined

    def _follow(
        self,
        url: str,
        probe: Probe,
        result: SourceResult,
        declared_fmt: str | None,
    ) -> list[Extraction]:
        """
        Find the data file an HTML page points at, and read that instead.

        One hop only. This is the recovery that makes most of the registry
        usable, and it is also the step most likely to wander off into a site's
        navigation if it were allowed to repeat.
        """
        fetched = self.fetcher.get(url)
        if fetched.error or not fetched.body:
            return []

        find = self.parsers["discovery"]
        try:
            links = find(fetched.body, probe.final_url or url, want=declared_fmt)
        except Exception as e:  # noqa: BLE001
            result.notes.append(f"Link discovery failed: {e}")
            return []

        if not links:
            result.notes.append(
                "This is a page rather than a data file, and no download link "
                "on it looked like the dataset."
            )
            return []

        out: list[Extraction] = []
        for link in links[: self.max_discovered]:
            result.notes.append(
                f"Followed a link found on the page: {link.url} ({link.reason})"
            )
            sub = self.fetcher.probe(link.url)
            if sub.error or sub.status >= 400 or sub.source_type not in DATA_TYPES:
                result.notes.append(
                    f"That link did not lead to readable data "
                    f"(status {sub.status}, looked like {sub.source_type.value})."
                )
                continue

            child = SourceResult(url=link.url, entity_slug=result.entity_slug, probe=sub)
            rows = self._extract(link.url, sub, child)
            result.notes.extend(child.notes)
            if child.error:
                result.notes.append(f"Reading that file failed: {child.error}")
            for ex in rows:
                if ex.provenance:
                    ex.provenance = replace(ex.provenance, discovered_from=url)
                ex.flags.append("via:link-discovery")
            out.extend(rows)
            if out:
                break  # the first link that yields data is enough

        return out


def run_urls(
    urls: list[dict],
    *,
    cache_dir: Path | None = None,
    delay_s: float = 1.0,
    follow_links: bool = True,
) -> list[SourceResult]:
    """
    Process a list of sources.

    Each entry is a dict with at least `url`, and optionally `entity_slug`,
    `fmt`, `reporter_iso3`, `reporter_name` and `flow`.
    """
    results: list[SourceResult] = []
    with Fetcher(cache_dir=cache_dir, delay_s=delay_s) as fetcher:
        pipe = Pipeline(fetcher, follow_links=follow_links)
        for i, item in enumerate(urls, 1):
            url = item["url"]
            log.info("[%d/%d] %s", i, len(urls), url)
            results.append(
                pipe.run_url(
                    url,
                    entity_slug=item.get("entity_slug"),
                    declared_fmt=item.get("fmt"),
                    source_ref=item.get("source_ref"),
                    reporter_iso3=item.get("reporter_iso3"),
                    reporter_name=item.get("reporter_name"),
                    default_flow=item.get("flow"),
                )
            )
    return results
