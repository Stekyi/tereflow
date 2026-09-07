"""
Writing the output, and refusing to write the rest.

Three files come out of a run and the split between them is the whole guarantee
this pipeline offers.

  facts.json        rows that can be posted to /api/admin/ingest/facts as they
                    are. Every one has a year, a flow, a reporting country and
                    a value known to be in US dollars.

  quarantine.json   rows that were extracted but did not qualify, each with the
                    reason. Nothing is discarded silently. A source that yields
                    four hundred rows in cedis produces an empty facts file and
                    four hundred quarantine entries saying so, which is a very
                    different message from a source that yields nothing.

  manifest.json     what ran, against what, and what came of it.

The narrowing from Extraction to Fact is the only place a row becomes something
the app will show, and it is deliberately dumb: it copies fields that exist and
refuses rows that are missing any of the four the database requires. There is
no filling in, no defaulting and no inference at this step, because anything
clever here would be invisible by the time it reached a reader.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .confidence import ACCEPT_THRESHOLD, explain
from .contracts import Extraction, Fact, SourceResult, Verdict

# The Worker rejects a body of more than 1200 facts, so files are chunked to
# stay under it. Matching the limit here means a file can always be posted
# whole rather than needing a splitter at the other end.
MAX_FACTS_PER_FILE = 1000


def to_fact(ex: Extraction, source_ref: str) -> Fact | None:
    """
    Narrow an extraction to something the database will accept, or decline.

    Returns None unless every column D1 declares NOT NULL is present and real.
    Nothing is defaulted. A missing year does not become the current year, a
    missing flow does not become 'export', and a value in an unknown currency
    does not become a dollar figure.
    """
    if ex.verdict is not Verdict.ACCEPTED:
        return None
    if ex.year is None or ex.flow is None or ex.value_usd is None:
        return None
    if ex.reporter_iso3 is None:
        return None

    return Fact(
        year=ex.year,
        flow=ex.flow,
        stream=ex.stream,
        value_usd=ex.value_usd,
        source_ref=source_ref,
        partner_iso3=ex.partner_iso3,
        partner_name=ex.partner_name,
        hs_code=ex.hs_code,
        product_name=ex.product_name,
        sector=ex.sector,
        qty=ex.qty,
        qty_unit=ex.qty_unit,
    )


def partition(
    extractions: Iterable[Extraction], source_ref: str
) -> tuple[list[Fact], list[Extraction]]:
    """Split scored extractions into what can be stored and what cannot."""
    facts: list[Fact] = []
    held: list[Extraction] = []
    for ex in extractions:
        fact = to_fact(ex, source_ref)
        if fact is None:
            held.append(ex)
        else:
            facts.append(fact)
    return facts, held


def _reason_counts(held: list[Extraction]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ex in held:
        key = ex.verdict.value if ex.verdict else "unknown"
        counts[key] = counts.get(key, 0) + 1
    return counts


def write_run(
    out_dir: Path,
    results: list[SourceResult],
    *,
    run_id: str,
    entity_slug: str | None = None,
) -> dict[str, object]:
    """
    Write a whole run to disk and return its manifest.

    Facts are grouped by entity slug so a file can be posted straight to the
    ingest endpoint, which takes one entity per request.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()

    by_entity: dict[str, list[Fact]] = {}
    all_held: list[Extraction] = []
    for r in results:
        slug = r.entity_slug or entity_slug or "unassigned"
        by_entity.setdefault(slug, []).extend(r.accepted)
        all_held.extend(r.quarantined)

    fact_files: list[str] = []
    for slug, facts in by_entity.items():
        if not facts:
            continue
        for i in range(0, len(facts), MAX_FACTS_PER_FILE):
            chunk = facts[i: i + MAX_FACTS_PER_FILE]
            part = i // MAX_FACTS_PER_FILE
            name = f"facts.{slug}.{part:03d}.json"
            payload = {
                "slug": slug,
                "facts": [f.to_json() for f in chunk],
            }
            _write(out_dir / name, payload)
            fact_files.append(name)

    quarantine_name = "quarantine.json"
    _write(
        out_dir / quarantine_name,
        {
            "run_id": run_id,
            "written_at": now,
            "count": len(all_held),
            "reasons": _reason_counts(all_held),
            "note": (
                "These rows were extracted and then held back. They are not errors "
                "and they are not guesses: each one names what stopped it. Rows held "
                "as non_usd carry a real value in the currency the source printed, "
                "and are waiting on a dated exchange rate rather than on a fix."
            ),
            "rows": [
                {**ex.to_json(), "explanation": explain(ex)} for ex in all_held
            ],
        },
    )

    manifest = {
        "run_id": run_id,
        "written_at": now,
        "accept_threshold": ACCEPT_THRESHOLD,
        "sources": len(results),
        "sources_with_facts": sum(1 for r in results if r.accepted),
        "sources_with_error": sum(1 for r in results if r.error),
        "facts_written": sum(len(f) for f in by_entity.values()),
        "quarantined": len(all_held),
        "quarantine_reasons": _reason_counts(all_held),
        "fact_files": fact_files,
        "quarantine_file": quarantine_name,
        "per_source": [
            {
                "url": r.url,
                "entity_slug": r.entity_slug,
                "detected_type": r.probe.source_type.value if r.probe else None,
                "detection_evidence": r.probe.evidence if r.probe else [],
                "http_status": r.probe.status if r.probe else None,
                "accepted": len(r.accepted),
                "quarantined": len(r.quarantined),
                "error": r.error,
                "notes": r.notes,
                "duration_ms": r.duration_ms,
            }
            for r in results
        ],
        "how_to_load": (
            "Each facts file is the exact body /api/admin/ingest/facts expects. "
            "POST it with an Authorization: Bearer ADMIN_TOKEN header. Nothing in "
            "these files needs reshaping, and nothing in them was inferred."
        ),
    }
    _write(out_dir / "manifest.json", manifest)
    return manifest


def _write(path: Path, payload: object) -> None:
    """
    UTF-8 without a BOM, and newline-terminated.

    A BOM here would be read as part of the first key by several JSON parsers,
    and this project has already lost time to a BOM breaking a build.
    """
    text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    path.write_text(text + "\n", encoding="utf-8")


def d1_insert_statements(facts: list[Fact], entity_id: str) -> list[tuple[str, list]]:
    """
    The same facts as parameterised SQL, for loading without the Worker.

    Bound parameters, never interpolation, and batched to seven rows because D1
    allows a hundred bound values per statement and each row binds thirteen.
    This exists for the case where somebody wants to load a file directly with
    wrangler rather than through the API.
    """
    cols = (
        "entity_id, year, flow, stream, partner_iso3, partner_name, "
        "hs_code, product_name, sector, value_usd, qty, qty_unit, source_ref"
    )
    per_statement = 7
    out: list[tuple[str, list]] = []
    for i in range(0, len(facts), per_statement):
        chunk = facts[i: i + per_statement]
        placeholders = ",".join(["(" + ",".join(["?"] * 13) + ")"] * len(chunk))
        binds: list = []
        for f in chunk:
            binds.extend(
                [
                    entity_id, f.year, f.flow, f.stream, f.partner_iso3,
                    f.partner_name, f.hs_code, f.product_name, f.sector,
                    f.value_usd, f.qty, f.qty_unit, f.source_ref,
                ]
            )
        out.append((f"INSERT INTO trade_facts ({cols}) VALUES {placeholders}", binds))
    return out
